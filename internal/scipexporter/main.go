package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/scip-code/scip/bindings/go/scip"
	"google.golang.org/protobuf/proto"
)

type request struct {
	ProjectRootURI string     `json:"project_root_uri"`
	ToolVersion    string     `json:"tool_version"`
	Repository     string     `json:"repository"`
	Documents      []document `json:"documents"`
}

type document struct {
	RelativePath string       `json:"relative_path"`
	Language     string       `json:"language"`
	Symbols      []definition `json:"symbols"`
}

type definition struct {
	SymbolID      string `json:"symbol_id"`
	Name          string `json:"name"`
	Kind          string `json:"kind"`
	Receiver      string `json:"receiver,omitempty"`
	Line          int32  `json:"line"`
	StartByte     int32  `json:"start_byte"`
	EndByte       int32  `json:"end_byte"`
	HasRange      bool   `json:"has_range"`
	Signature     string `json:"signature,omitempty"`
	Documentation string `json:"documentation,omitempty"`
}

type inspectDocument struct {
	RelativePath string   `json:"relative_path"`
	Language     string   `json:"language"`
	Symbols      int      `json:"symbols"`
	Occurrences  int      `json:"occurrences"`
	Definitions  []string `json:"definitions"`
}

type inspectSummary struct {
	ToolName    string            `json:"tool_name"`
	ToolVersion string            `json:"tool_version"`
	ProjectRoot string            `json:"project_root"`
	Documents   []inspectDocument `json:"documents"`
}

func normalizedLanguage(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "go":
		return "Go"
	case "typescript":
		return "TypeScript"
	case "javascript":
		return "JavaScript"
	case "java":
		return "Java"
	case "python":
		return "Python"
	case "c":
		return "C"
	case "cpp", "c++":
		return "CPP"
	case "csharp", "c#":
		return "CSharp"
	case "rust":
		return "Rust"
	case "vue":
		return "Vue"
	default:
		return value
	}
}

func cleanReceiver(value string) string {
	value = strings.TrimSpace(value)
	value = strings.TrimLeft(value, "*")
	if index := strings.Index(value, "["); index >= 0 {
		value = value[:index]
	}
	if index := strings.LastIndex(value, "."); index >= 0 {
		value = value[index+1:]
	}
	return value
}

func scipKind(value string) scip.SymbolInformation_Kind {
	switch strings.ToLower(value) {
	case "method":
		return scip.SymbolInformation_Method
	case "class":
		return scip.SymbolInformation_Class
	case "interface":
		return scip.SymbolInformation_Interface
	case "type", "struct":
		return scip.SymbolInformation_Struct
	case "constant":
		return scip.SymbolInformation_Constant
	case "variable":
		return scip.SymbolInformation_Variable
	default:
		return scip.SymbolInformation_Function
	}
}

func namespaceDescriptors(relativePath string) []*scip.Descriptor {
	clean := filepath.ToSlash(relativePath)
	ext := filepath.Ext(clean)
	stem := strings.TrimSuffix(clean, ext)
	parts := strings.Split(stem, "/")
	out := make([]*scip.Descriptor, 0, len(parts))
	for _, part := range parts {
		if part == "" {
			continue
		}
		out = append(out, &scip.Descriptor{
			Name:   part,
			Suffix: scip.Descriptor_Namespace,
		})
	}
	return out
}

func formatSymbol(repository string, doc document, def definition) (string, error) {
	descriptors := namespaceDescriptors(doc.RelativePath)
	receiver := cleanReceiver(def.Receiver)
	if receiver != "" {
		descriptors = append(descriptors, &scip.Descriptor{
			Name:   receiver,
			Suffix: scip.Descriptor_Type,
		})
	}
	suffix := scip.Descriptor_Term
	if strings.EqualFold(def.Kind, "method") {
		suffix = scip.Descriptor_Method
	}
	descriptors = append(descriptors, &scip.Descriptor{
		Name:   def.Name,
		Suffix: suffix,
	})

	symbol := &scip.Symbol{
		Scheme: "cce",
		Package: &scip.Package{
			Manager: ".",
			Name:    repository,
			Version: ".",
		},
		Descriptors: descriptors,
	}
	formatted := scip.VerboseSymbolFormatter.FormatSymbol(symbol)
	if _, err := scip.ParseSymbol(formatted); err != nil {
		return "", fmt.Errorf("invalid generated SCIP symbol %q: %w", formatted, err)
	}
	return formatted, nil
}

func buildIndex(req request) (*scip.Index, error) {
	if strings.TrimSpace(req.ProjectRootURI) == "" {
		return nil, errors.New("project_root_uri is required")
	}
	if strings.TrimSpace(req.Repository) == "" {
		req.Repository = "."
	}

	sort.Slice(req.Documents, func(i, j int) bool {
		return req.Documents[i].RelativePath < req.Documents[j].RelativePath
	})

	index := &scip.Index{
		Metadata: &scip.Metadata{
			Version: scip.ProtocolVersion_UnspecifiedProtocolVersion,
			ToolInfo: &scip.ToolInfo{
				Name:    "code-context-engine",
				Version: req.ToolVersion,
			},
			ProjectRoot:          req.ProjectRootURI,
			TextDocumentEncoding: scip.TextEncoding_UTF8,
		},
	}

	for _, input := range req.Documents {
		doc := &scip.Document{
			Language:         normalizedLanguage(input.Language),
			RelativePath:     filepath.ToSlash(input.RelativePath),
			PositionEncoding: scip.PositionEncoding_UTF8CodeUnitOffsetFromLineStart,
		}
		sort.Slice(input.Symbols, func(i, j int) bool {
			if input.Symbols[i].Line != input.Symbols[j].Line {
				return input.Symbols[i].Line < input.Symbols[j].Line
			}
			return input.Symbols[i].SymbolID < input.Symbols[j].SymbolID
		})
		for _, def := range input.Symbols {
			symbol, err := formatSymbol(req.Repository, input, def)
			if err != nil {
				return nil, err
			}
			info := &scip.SymbolInformation{
				Symbol:      symbol,
				Kind:        scipKind(def.Kind),
				DisplayName: def.Name,
			}
			if strings.TrimSpace(def.Documentation) != "" {
				info.Documentation = []string{def.Documentation}
			}
			if strings.TrimSpace(def.Signature) != "" {
				info.SignatureDocumentation = &scip.Signature{
					Language: normalizedLanguage(input.Language),
					Text:     def.Signature,
				}
			}
			doc.Symbols = append(doc.Symbols, info)
			if def.HasRange && def.Line >= 1 && def.StartByte >= 0 && def.EndByte >= def.StartByte {
				doc.Occurrences = append(doc.Occurrences, &scip.Occurrence{
					TypedRange: &scip.Occurrence_SingleLineRange{
						SingleLineRange: &scip.SingleLineRange{
							Line:           def.Line - 1,
							StartCharacter: def.StartByte,
							EndCharacter:   def.EndByte,
						},
					},
					Symbol:      symbol,
					SymbolRoles: int32(scip.SymbolRole_Definition),
				})
			}
		}
		index.Documents = append(index.Documents, doc)
	}

	return index, nil
}

func encode(output string) error {
	var req request
	if err := json.NewDecoder(bufio.NewReader(os.Stdin)).Decode(&req); err != nil {
		return err
	}
	index, err := buildIndex(req)
	if err != nil {
		return err
	}
	payload, err := proto.Marshal(index)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(output), 0o755); err != nil {
		return err
	}
	return os.WriteFile(output, payload, 0o644)
}

func inspect(input string) error {
	payload, err := os.ReadFile(input)
	if err != nil {
		return err
	}
	var index scip.Index
	if err := proto.Unmarshal(payload, &index); err != nil {
		return err
	}
	summary := inspectSummary{
		ProjectRoot: index.GetMetadata().GetProjectRoot(),
	}
	if tool := index.GetMetadata().GetToolInfo(); tool != nil {
		summary.ToolName = tool.GetName()
		summary.ToolVersion = tool.GetVersion()
	}
	for _, doc := range index.GetDocuments() {
		item := inspectDocument{
			RelativePath: doc.GetRelativePath(),
			Language:     doc.GetLanguage(),
			Symbols:      len(doc.GetSymbols()),
			Occurrences:  len(doc.GetOccurrences()),
		}
		for _, occurrence := range doc.GetOccurrences() {
			if scip.SymbolRole_Definition.Matches(occurrence) {
				item.Definitions = append(item.Definitions, occurrence.GetSymbol())
			}
		}
		sort.Strings(item.Definitions)
		summary.Documents = append(summary.Documents, item)
	}
	return json.NewEncoder(os.Stdout).Encode(summary)
}

func main() {
	if len(os.Args) < 3 {
		fmt.Fprintln(os.Stderr, "usage: scipexporter encode <out.scip> | inspect <index.scip>")
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "encode":
		err = encode(os.Args[2])
	case "inspect":
		err = inspect(os.Args[2])
	default:
		err = fmt.Errorf("unknown command %q", os.Args[1])
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

package main

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/printer"
	"go/token"
	"go/types"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"golang.org/x/tools/go/packages"
)

type Request struct {
	Root  string   `json:"root"`
	Files []string `json:"files"`
}

type Param struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

type MethodShape struct {
	Name    string   `json:"name"`
	Params  []string `json:"params"`
	Returns []string `json:"returns"`
}

type InterfaceFact struct {
	Methods  []MethodShape
	Complete bool
}

type Diagnostic struct {
	Severity string `json:"severity"`
	Code     string `json:"code"`
	Message  string `json:"message"`
}

type CallFact struct {
	Name             string
	Metadata         map[string]any
	ResolvedSymbolID string
}

type TypedCall struct {
	Name             string
	Metadata         map[string]any
	ResolvedSymbolID string
}

type Sym struct {
	SymbolID           string   `json:"symbol_id"`
	FilePath           string   `json:"file_path"`
	Language           string   `json:"language"`
	Name               string   `json:"name"`
	QualifiedName      string   `json:"qualified_name"`
	Kind               string   `json:"kind"`
	Receiver           *string  `json:"receiver"`
	Signature          string   `json:"signature"`
	Params             []Param  `json:"params"`
	Returns            []Param  `json:"returns"`
	Description        string   `json:"description"`
	DescriptionSource  string   `json:"description_source"`
	LineStart          int      `json:"line_start"`
	LineEnd            int      `json:"line_end"`
	ImplementationHash string   `json:"implementation_hash"`
	SemanticHash       string   `json:"semantic_hash"`
	Calls              []string `json:"calls"`
}

type Dep struct {
	FromFile         string         `json:"from_file"`
	FromSymbolID     *string        `json:"from_symbol_id"`
	Relation         string         `json:"relation"`
	ToRef            string         `json:"to_ref"`
	ResolvedSymbolID *string        `json:"resolved_symbol_id,omitempty"`
	Metadata         map[string]any `json:"metadata,omitempty"`
}

type Result struct {
	FilePath     string       `json:"file_path"`
	Package      string       `json:"package"`
	Symbols      []Sym        `json:"symbols"`
	Dependencies []Dep        `json:"dependencies"`
	Diagnostics  []Diagnostic `json:"diagnostics,omitempty"`
	Error        string       `json:"error,omitempty"`
}

type TypedState struct {
	CallsBySymbol     map[string]map[string]TypedCall
	DiagnosticsByFile map[string][]Diagnostic
}

func nodeString(fset *token.FileSet, node any) string {
	var b strings.Builder
	if err := printer.Fprint(&b, fset, node); err != nil {
		return ""
	}
	return b.String()
}

func hashBytes(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

func recvName(fset *token.FileSet, field *ast.FieldList) string {
	if field == nil || len(field.List) == 0 {
		return ""
	}
	return strings.TrimSpace(nodeString(fset, field.List[0].Type))
}

func params(fset *token.FileSet, list *ast.FieldList) []Param {
	out := []Param{}
	if list == nil {
		return out
	}
	for _, f := range list.List {
		typ := nodeString(fset, f.Type)
		if len(f.Names) == 0 {
			out = append(out, Param{Name: "", Type: typ})
			continue
		}
		for _, n := range f.Names {
			out = append(out, Param{Name: n.Name, Type: typ})
		}
	}
	return out
}

func typeBase(value string) string {
	raw := strings.TrimSpace(value)
	for strings.HasPrefix(raw, "(") && strings.HasSuffix(raw, ")") && len(raw) > 1 {
		raw = strings.TrimSpace(raw[1 : len(raw)-1])
	}
	raw = strings.TrimLeft(raw, "*")
	if index := strings.Index(raw, "["); index >= 0 {
		raw = raw[:index]
	}
	if index := strings.LastIndex(raw, "."); index >= 0 {
		raw = raw[index+1:]
	}
	return raw
}

func typeList(fset *token.FileSet, list *ast.FieldList) []string {
	out := []string{}
	if list == nil {
		return out
	}
	for _, field := range list.List {
		typ := strings.TrimSpace(nodeString(fset, field.Type))
		count := len(field.Names)
		if count == 0 {
			count = 1
		}
		for i := 0; i < count; i++ {
			out = append(out, typ)
		}
	}
	return out
}

func collectTypeFacts(fset *token.FileSet, file *ast.File) (map[string]map[string]string, map[string]InterfaceFact) {
	structs := map[string]map[string]string{}
	interfaces := map[string]InterfaceFact{}
	for _, decl := range file.Decls {
		gen, ok := decl.(*ast.GenDecl)
		if !ok || gen.Tok != token.TYPE {
			continue
		}
		for _, spec := range gen.Specs {
			typeSpec, ok := spec.(*ast.TypeSpec)
			if !ok {
				continue
			}
			switch value := typeSpec.Type.(type) {
			case *ast.StructType:
				fields := map[string]string{}
				for _, field := range value.Fields.List {
					if len(field.Names) == 0 {
						continue
					}
					fieldType := strings.TrimSpace(nodeString(fset, field.Type))
					for _, name := range field.Names {
						fields[name.Name] = fieldType
					}
				}
				structs[typeSpec.Name.Name] = fields
			case *ast.InterfaceType:
				complete := true
				methods := []MethodShape{}
				for _, field := range value.Methods.List {
					if len(field.Names) != 1 {
						complete = false
						continue
					}
					fnType, ok := field.Type.(*ast.FuncType)
					if !ok {
						complete = false
						continue
					}
					methods = append(methods, MethodShape{
						Name:    field.Names[0].Name,
						Params:  typeList(fset, fnType.Params),
						Returns: typeList(fset, fnType.Results),
					})
				}
				sort.Slice(methods, func(i, j int) bool { return methods[i].Name < methods[j].Name })
				interfaces[typeSpec.Name.Name] = InterfaceFact{Methods: methods, Complete: complete}
			}
		}
	}
	return structs, interfaces
}

func receiverVariable(fn *ast.FuncDecl) string {
	if fn.Recv == nil || len(fn.Recv.List) == 0 || len(fn.Recv.List[0].Names) == 0 {
		return ""
	}
	return fn.Recv.List[0].Names[0].Name
}

func unwrapCallExpr(expr ast.Expr) ast.Expr {
	switch value := expr.(type) {
	case *ast.IndexExpr:
		return unwrapCallExpr(value.X)
	case *ast.IndexListExpr:
		return unwrapCallExpr(value.X)
	case *ast.ParenExpr:
		return unwrapCallExpr(value.X)
	default:
		return expr
	}
}

func callName(fset *token.FileSet, expr ast.Expr) string {
	switch fun := unwrapCallExpr(expr).(type) {
	case *ast.Ident:
		return fun.Name
	case *ast.SelectorExpr:
		return strings.TrimSpace(nodeString(fset, fun))
	default:
		return ""
	}
}

func callFacts(fset *token.FileSet, fn *ast.FuncDecl, structs map[string]map[string]string, interfaces map[string]InterfaceFact) ([]string, []CallFact) {
	byName := map[string]CallFact{}
	if fn.Body == nil {
		return []string{}, []CallFact{}
	}
	receiverVar := receiverVariable(fn)
	receiverType := recvName(fset, fn.Recv)
	receiverFields := structs[typeBase(receiverType)]
	ast.Inspect(fn.Body, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		name := callName(fset, call.Fun)
		if name == "" {
			return true
		}
		var metadata map[string]any
		if fun, ok := unwrapCallExpr(call.Fun).(*ast.SelectorExpr); ok && receiverVar != "" {
			if base, ok := fun.X.(*ast.Ident); ok && base.Name == receiverVar {
				metadata = map[string]any{
					"call_kind":     "receiver_method",
					"receiver_type": receiverType,
					"method":        fun.Sel.Name,
				}
			} else if inner, ok := fun.X.(*ast.SelectorExpr); ok {
				if base, ok := inner.X.(*ast.Ident); ok && base.Name == receiverVar {
					fieldName := inner.Sel.Name
					metadata = map[string]any{
						"call_kind":      "receiver_field_method",
						"receiver_type":  receiverType,
						"receiver_field": fieldName,
						"method":         fun.Sel.Name,
						"field_kind":     "unknown",
					}
					if fieldType, ok := receiverFields[fieldName]; ok {
						metadata["field_type"] = fieldType
						if iface, ok := interfaces[typeBase(fieldType)]; ok {
							metadata["field_kind"] = "interface"
							metadata["interface_complete"] = iface.Complete
							metadata["interface_methods"] = iface.Methods
						} else {
							metadata["field_kind"] = "concrete"
						}
					}
				}
			}
		}
		current, exists := byName[name]
		if !exists || (current.Metadata == nil && metadata != nil) {
			byName[name] = CallFact{Name: name, Metadata: metadata}
		}
		return true
	})
	names := make([]string, 0, len(byName))
	for name := range byName {
		names = append(names, name)
	}
	sort.Strings(names)
	facts := make([]CallFact, 0, len(names))
	for _, name := range names {
		facts = append(facts, byName[name])
	}
	if len(names) > 100 {
		names = names[:100]
		facts = facts[:100]
	}
	return names, facts
}

func relInside(root, full string) (string, bool) {
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return "", false
	}
	absFull, err := filepath.Abs(full)
	if err != nil {
		return "", false
	}
	rel, err := filepath.Rel(absRoot, absFull)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return "", false
	}
	return filepath.ToSlash(rel), true
}

func fileExists(name string) bool {
	info, err := os.Stat(name)
	return err == nil && !info.IsDir()
}

func nearestModuleDir(root, rel string) string {
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return ""
	}
	current := filepath.Dir(filepath.Join(absRoot, filepath.FromSlash(rel)))
	for {
		if fileExists(filepath.Join(current, "go.mod")) {
			return current
		}
		if current == absRoot {
			return ""
		}
		parent := filepath.Dir(current)
		if parent == current {
			return ""
		}
		if _, ok := relInside(absRoot, parent); !ok {
			return ""
		}
		current = parent
	}
}

func setEnvValue(env []string, key, value string) []string {
	prefix := key + "="
	for i, item := range env {
		if strings.HasPrefix(item, prefix) {
			env[i] = prefix + value
			return env
		}
	}
	return append(env, prefix+value)
}

func readonlyGoEnv() []string {
	env := append([]string{}, os.Environ()...)
	flags := strings.TrimSpace(os.Getenv("GOFLAGS"))
	if !strings.Contains(flags, "-mod=") {
		if flags == "" {
			flags = "-mod=readonly"
		} else {
			flags += " -mod=readonly"
		}
	}
	env = setEnvValue(env, "GOFLAGS", flags)
	env = setEnvValue(env, "GOPROXY", "off")
	env = setEnvValue(env, "GOSUMDB", "off")
	env = setEnvValue(env, "GOTOOLCHAIN", "local")
	return env
}

func goSymbolID(fset *token.FileSet, rel string, fn *ast.FuncDecl) string {
	receiver := recvName(fset, fn.Recv)
	qualified := fn.Name.Name
	if receiver != "" {
		qualified = receiver + "." + fn.Name.Name
	}
	return fmt.Sprintf("go:%s::%s", filepath.ToSlash(rel), qualified)
}

func isInterfaceType(value types.Type) bool {
	if value == nil {
		return false
	}
	for {
		switch typ := value.(type) {
		case *types.Pointer:
			value = typ.Elem()
		case *types.Named:
			value = typ.Underlying()
		default:
			_, ok := value.(*types.Interface)
			return ok
		}
	}
}

func typeString(value types.Type) string {
	if value == nil {
		return ""
	}
	return types.TypeString(value, func(pkg *types.Package) string {
		if pkg == nil {
			return ""
		}
		return pkg.Name()
	})
}

func mergeMetadata(base, extra map[string]any) map[string]any {
	if len(base) == 0 && len(extra) == 0 {
		return nil
	}
	out := map[string]any{}
	for key, value := range base {
		out[key] = value
	}
	for key, value := range extra {
		out[key] = value
	}
	return out
}

func typedCallFor(info *types.Info, call *ast.CallExpr, targetByObject map[types.Object]string) (TypedCall, bool) {
	base := unwrapCallExpr(call.Fun)
	name := ""
	var obj types.Object
	var selection *types.Selection

	switch fun := base.(type) {
	case *ast.Ident:
		name = fun.Name
		obj = info.Uses[fun]
	case *ast.SelectorExpr:
		name = strings.TrimSpace(fun.Sel.Name)
		selection = info.Selections[fun]
		if selection != nil {
			obj = selection.Obj()
		} else {
			obj = info.Uses[fun.Sel]
		}
	default:
		return TypedCall{}, false
	}

	fn, ok := obj.(*types.Func)
	if !ok {
		return TypedCall{}, false
	}

	metadata := map[string]any{
		"go_types_checked": true,
		"target_name":      fn.Name(),
	}
	if fn.Pkg() != nil {
		metadata["target_package"] = fn.Pkg().Path()
	}

	resolved := targetByObject[fn]
	if resolved == "" {
		if origin := fn.Origin(); origin != fn {
			resolved = targetByObject[origin]
		}
	}

	if selection != nil {
		metadata["receiver_type"] = typeString(selection.Recv())
		metadata["selection_kind"] = fmt.Sprint(selection.Kind())
		if isInterfaceType(selection.Recv()) {
			metadata["resolution"] = "go_types_interface_dispatch_unresolved"
			return TypedCall{Name: name, Metadata: metadata}, true
		}
	}

	if resolved != "" {
		metadata["resolution"] = "go_types_object"
		return TypedCall{Name: name, Metadata: metadata, ResolvedSymbolID: resolved}, true
	}

	if fn.Pkg() == nil {
		metadata["resolution"] = "go_types_builtin_or_untracked"
	} else {
		metadata["resolution"] = "go_types_target_unindexed"
	}
	return TypedCall{Name: name, Metadata: metadata}, true
}

func recordTypedCall(target map[string]TypedCall, call TypedCall) {
	current, exists := target[call.Name]
	if !exists {
		target[call.Name] = call
		return
	}
	if current.ResolvedSymbolID == call.ResolvedSymbolID {
		current.Metadata = mergeMetadata(current.Metadata, call.Metadata)
		target[call.Name] = current
		return
	}
	current.ResolvedSymbolID = ""
	current.Metadata = mergeMetadata(current.Metadata, map[string]any{
		"go_types_checked": true,
		"resolution":       "go_types_call_ambiguous",
		"candidate_count":  2,
	})
	target[call.Name] = current
}

func packageErrors(pkg *packages.Package) []Diagnostic {
	out := []Diagnostic{}
	for _, item := range pkg.Errors {
		if len(out) >= 8 {
			break
		}
		out = append(out, Diagnostic{
			Severity: "warning",
			Code:     "go_packages_error",
			Message:  item.Msg,
		})
	}
	return out
}

func packageGraph(roots []*packages.Package) []*packages.Package {
	seen := map[*packages.Package]bool{}
	out := []*packages.Package{}
	var visit func(*packages.Package)
	visit = func(pkg *packages.Package) {
		if pkg == nil || seen[pkg] {
			return
		}
		seen[pkg] = true
		out = append(out, pkg)
		keys := make([]string, 0, len(pkg.Imports))
		for path := range pkg.Imports {
			keys = append(keys, path)
		}
		sort.Strings(keys)
		for _, path := range keys {
			visit(pkg.Imports[path])
		}
	}
	orderedRoots := append([]*packages.Package{}, roots...)
	sort.Slice(orderedRoots, func(i, j int) bool {
		return orderedRoots[i].ID < orderedRoots[j].ID
	})
	for _, pkg := range orderedRoots {
		visit(pkg)
	}
	return out
}

func buildTypedState(root string, files []string) TypedState {
	state := TypedState{
		CallsBySymbol:     map[string]map[string]TypedCall{},
		DiagnosticsByFile: map[string][]Diagnostic{},
	}

	moduleFiles := map[string][]string{}
	for _, rel := range files {
		moduleDir := nearestModuleDir(root, rel)
		if moduleDir == "" {
			continue
		}
		moduleFiles[moduleDir] = append(moduleFiles[moduleDir], rel)
	}

	moduleDirs := make([]string, 0, len(moduleFiles))
	for dir := range moduleFiles {
		moduleDirs = append(moduleDirs, dir)
	}
	sort.Strings(moduleDirs)

	for _, moduleDir := range moduleDirs {
		cfg := &packages.Config{
			Mode: packages.NeedName |
				packages.NeedFiles |
				packages.NeedCompiledGoFiles |
				packages.NeedSyntax |
				packages.NeedTypes |
				packages.NeedTypesInfo |
				packages.NeedImports |
				packages.NeedDeps |
				packages.NeedModule,
			Dir:   moduleDir,
			Env:   readonlyGoEnv(),
			Tests: false,
		}
		loaded, err := packages.Load(cfg, "./...")
		if err != nil {
			diag := Diagnostic{
				Severity: "warning",
				Code:     "go_packages_load_failed",
				Message:  err.Error(),
			}
			for _, rel := range moduleFiles[moduleDir] {
				state.DiagnosticsByFile[rel] = append(state.DiagnosticsByFile[rel], diag)
			}
			continue
		}

		targetByObject := map[types.Object]string{}
		fileToPackage := map[string]*packages.Package{}
		fileToSyntax := map[string]*ast.File{}

		for _, pkg := range packageGraph(loaded) {
			if pkg == nil || pkg.Fset == nil {
				continue
			}
			for index, syntax := range pkg.Syntax {
				if index >= len(pkg.CompiledGoFiles) {
					continue
				}
				rel, ok := relInside(root, pkg.CompiledGoFiles[index])
				if !ok {
					continue
				}
				fileToPackage[rel] = pkg
				fileToSyntax[rel] = syntax
				if len(pkg.Errors) > 0 {
					continue
				}
				for _, decl := range syntax.Decls {
					fn, ok := decl.(*ast.FuncDecl)
					if !ok || fn.Name == nil || pkg.TypesInfo == nil {
						continue
					}
					obj := pkg.TypesInfo.Defs[fn.Name]
					if obj == nil {
						continue
					}
					targetByObject[obj] = goSymbolID(pkg.Fset, rel, fn)
				}
			}
		}

		for rel, pkg := range fileToPackage {
			if len(pkg.Errors) > 0 {
				state.DiagnosticsByFile[rel] = append(
					state.DiagnosticsByFile[rel],
					packageErrors(pkg)...,
				)
				continue
			}
			syntax := fileToSyntax[rel]
			if syntax == nil || pkg.TypesInfo == nil {
				continue
			}
			for _, decl := range syntax.Decls {
				fn, ok := decl.(*ast.FuncDecl)
				if !ok || fn.Body == nil {
					continue
				}
				symbolID := goSymbolID(pkg.Fset, rel, fn)
				byName := map[string]TypedCall{}
				ast.Inspect(fn.Body, func(node ast.Node) bool {
					call, ok := node.(*ast.CallExpr)
					if !ok {
						return true
					}
					typed, ok := typedCallFor(pkg.TypesInfo, call, targetByObject)
					if !ok {
						return true
					}
					typed.Name = callName(pkg.Fset, call.Fun)
					if typed.Name == "" {
						return true
					}
					recordTypedCall(byName, typed)
					return true
				})
				if len(byName) > 0 {
					state.CallsBySymbol[symbolID] = byName
				}
			}
		}
	}

	return state
}

func applyTypedCalls(callDeps []CallFact, typed map[string]TypedCall) []CallFact {
	if len(typed) == 0 {
		return callDeps
	}
	for index := range callDeps {
		target, ok := typed[callDeps[index].Name]
		if !ok {
			continue
		}
		callDeps[index].Metadata = mergeMetadata(callDeps[index].Metadata, target.Metadata)
		callDeps[index].ResolvedSymbolID = target.ResolvedSymbolID
	}
	return callDeps
}

func main() {
	var req Request
	if err := json.NewDecoder(bufio.NewReader(os.Stdin)).Decode(&req); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}

	typed := buildTypedState(req.Root, req.Files)
	enc := json.NewEncoder(os.Stdout)

	for _, rel := range req.Files {
		full := filepath.Join(req.Root, filepath.FromSlash(rel))
		src, err := os.ReadFile(full)
		if err != nil {
			enc.Encode(Result{FilePath: rel, Error: err.Error()})
			continue
		}

		fset := token.NewFileSet()
		file, err := parser.ParseFile(fset, full, src, parser.ParseComments)
		if err != nil {
			enc.Encode(Result{FilePath: rel, Error: err.Error()})
			continue
		}

		structs, interfaces := collectTypeFacts(fset, file)
		relID := filepath.ToSlash(rel)
		pkg := file.Name.Name
		deps := []Dep{}
		for _, imp := range file.Imports {
			deps = append(deps, Dep{
				FromFile: rel,
				Relation: "imports",
				ToRef:    strings.Trim(imp.Path.Value, "\""),
			})
		}

		syms := []Sym{}
		for _, decl := range file.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok {
				continue
			}

			receiver := recvName(fset, fn.Recv)
			qualified := fn.Name.Name
			kind := "function"
			var recvPtr *string
			if receiver != "" {
				qualified = receiver + "." + fn.Name.Name
				kind = "method"
				value := receiver
				recvPtr = &value
			}
			id := fmt.Sprintf("go:%s::%s", relID, qualified)

			start := fset.Position(fn.Pos())
			end := fset.Position(fn.End())
			startOffset := start.Offset
			endOffset := end.Offset
			if startOffset < 0 {
				startOffset = 0
			}
			if endOffset > len(src) {
				endOffset = len(src)
			}
			if endOffset < startOffset {
				endOffset = startOffset
			}

			ps := params(fset, fn.Type.Params)
			rs := params(fset, fn.Type.Results)
			sig := strings.TrimSpace(nodeString(fset, fn.Type))
			doc := ""
			source := "derived"
			if fn.Doc != nil {
				doc = strings.TrimSpace(fn.Doc.Text())
				source = "comment"
			}

			calls, callDeps := callFacts(fset, fn, structs, interfaces)
			callDeps = applyTypedCalls(callDeps, typed.CallsBySymbol[id])

			description := doc
			if description == "" {
				names := []string{}
				for _, p := range ps {
					if p.Name != "" {
						names = append(names, p.Name)
					}
				}
				description = fmt.Sprintf("%s(%s) in %s", qualified, strings.Join(names, ", "), rel)
				if len(calls) > 0 {
					max := len(calls)
					if max > 8 {
						max = 8
					}
					description += "; calls " + strings.Join(calls[:max], ", ")
				}
				description += "."
			}

			semantic, _ := json.Marshal(map[string]any{
				"name":        qualified,
				"signature":   sig,
				"params":      ps,
				"returns":     rs,
				"description": description,
				"calls":       calls,
			})
			syms = append(syms, Sym{
				SymbolID:           id,
				FilePath:           rel,
				Language:           "go",
				Name:               fn.Name.Name,
				QualifiedName:      qualified,
				Kind:               kind,
				Receiver:           recvPtr,
				Signature:          sig,
				Params:             ps,
				Returns:            rs,
				Description:        description,
				DescriptionSource:  source,
				LineStart:          start.Line,
				LineEnd:            end.Line,
				ImplementationHash: hashBytes(src[startOffset:endOffset]),
				SemanticHash:       hashBytes(semantic),
				Calls:              calls,
			})

			sid := id
			for _, call := range callDeps {
				var resolved *string
				if call.ResolvedSymbolID != "" {
					value := call.ResolvedSymbolID
					resolved = &value
				}
				deps = append(deps, Dep{
					FromFile:         rel,
					FromSymbolID:     &sid,
					Relation:         "calls",
					ToRef:            call.Name,
					ResolvedSymbolID: resolved,
					Metadata:         call.Metadata,
				})
			}
		}

		enc.Encode(Result{
			FilePath:     rel,
			Package:      pkg,
			Symbols:      syms,
			Dependencies: deps,
			Diagnostics:  typed.DiagnosticsByFile[rel],
		})
	}
}

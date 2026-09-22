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
  "os"
  "path/filepath"
  "sort"
  "strings"
)

type Request struct { Root string `json:"root"`; Files []string `json:"files"` }
type Param struct { Name string `json:"name"`; Type string `json:"type"` }
type MethodShape struct {
  Name string `json:"name"`
  Params []string `json:"params"`
  Returns []string `json:"returns"`
}
type InterfaceFact struct { Methods []MethodShape; Complete bool }
type CallFact struct { Name string; Metadata map[string]any }
type Sym struct {
  SymbolID string `json:"symbol_id"`; FilePath string `json:"file_path"`; Language string `json:"language"`;
  Name string `json:"name"`; QualifiedName string `json:"qualified_name"`; Kind string `json:"kind"`; Receiver *string `json:"receiver"`;
  Signature string `json:"signature"`; Params []Param `json:"params"`; Returns []Param `json:"returns"`; Description string `json:"description"`;
  DescriptionSource string `json:"description_source"`; LineStart int `json:"line_start"`; LineEnd int `json:"line_end"`;
  ImplementationHash string `json:"implementation_hash"`; SemanticHash string `json:"semantic_hash"`; Calls []string `json:"calls"`;
}
type Dep struct { FromFile string `json:"from_file"`; FromSymbolID *string `json:"from_symbol_id"`; Relation string `json:"relation"`; ToRef string `json:"to_ref"`; Metadata map[string]any `json:"metadata,omitempty"` }
type Result struct { FilePath string `json:"file_path"`; Package string `json:"package"`; Symbols []Sym `json:"symbols"`; Dependencies []Dep `json:"dependencies"`; Error string `json:"error,omitempty"` }

func nodeString(fset *token.FileSet, node any) string {
  var b strings.Builder
  if err := printer.Fprint(&b, fset, node); err != nil { return "" }
  return b.String()
}
func hashBytes(b []byte) string { h:=sha256.Sum256(b); return hex.EncodeToString(h[:]) }
func recvName(fset *token.FileSet, field *ast.FieldList) string {
  if field == nil || len(field.List)==0 { return "" }
  return strings.TrimSpace(nodeString(fset, field.List[0].Type))
}
func params(fset *token.FileSet, list *ast.FieldList) []Param {
  out:=[]Param{}; if list==nil { return out }
  for _, f := range list.List { typ:=nodeString(fset,f.Type); if len(f.Names)==0 { out=append(out,Param{Name:"",Type:typ}); continue }; for _,n:=range f.Names { out=append(out,Param{Name:n.Name,Type:typ}) } }
  return out
}
func typeBase(value string) string {
  raw := strings.TrimSpace(value)
  for strings.HasPrefix(raw, "(") && strings.HasSuffix(raw, ")") && len(raw) > 1 {
    raw = strings.TrimSpace(raw[1:len(raw)-1])
  }
  raw = strings.TrimLeft(raw, "*")
  if index := strings.Index(raw, "["); index >= 0 { raw = raw[:index] }
  if index := strings.LastIndex(raw, "."); index >= 0 { raw = raw[index+1:] }
  return raw
}

func typeList(fset *token.FileSet, list *ast.FieldList) []string {
  out := []string{}
  if list == nil { return out }
  for _, field := range list.List {
    typ := strings.TrimSpace(nodeString(fset, field.Type))
    count := len(field.Names)
    if count == 0 { count = 1 }
    for i := 0; i < count; i++ { out = append(out, typ) }
  }
  return out
}

func collectTypeFacts(fset *token.FileSet, file *ast.File) (map[string]map[string]string, map[string]InterfaceFact) {
  structs := map[string]map[string]string{}
  interfaces := map[string]InterfaceFact{}
  for _, decl := range file.Decls {
    gen, ok := decl.(*ast.GenDecl)
    if !ok || gen.Tok != token.TYPE { continue }
    for _, spec := range gen.Specs {
      typeSpec, ok := spec.(*ast.TypeSpec)
      if !ok { continue }
      switch value := typeSpec.Type.(type) {
      case *ast.StructType:
        fields := map[string]string{}
        for _, field := range value.Fields.List {
          if len(field.Names) == 0 { continue }
          fieldType := strings.TrimSpace(nodeString(fset, field.Type))
          for _, name := range field.Names { fields[name.Name] = fieldType }
        }
        structs[typeSpec.Name.Name] = fields
      case *ast.InterfaceType:
        complete := true
        methods := []MethodShape{}
        for _, field := range value.Methods.List {
          if len(field.Names) != 1 { complete = false; continue }
          fnType, ok := field.Type.(*ast.FuncType)
          if !ok { complete = false; continue }
          methods = append(methods, MethodShape{
            Name: field.Names[0].Name,
            Params: typeList(fset, fnType.Params),
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
  if fn.Recv == nil || len(fn.Recv.List) == 0 || len(fn.Recv.List[0].Names) == 0 { return "" }
  return fn.Recv.List[0].Names[0].Name
}

func callFacts(fset *token.FileSet, fn *ast.FuncDecl, structs map[string]map[string]string, interfaces map[string]InterfaceFact) ([]string, []CallFact) {
  byName := map[string]CallFact{}
  if fn.Body == nil { return []string{}, []CallFact{} }
  receiverVar := receiverVariable(fn)
  receiverType := recvName(fset, fn.Recv)
  receiverFields := structs[typeBase(receiverType)]
  ast.Inspect(fn.Body, func(n ast.Node) bool {
    call, ok := n.(*ast.CallExpr)
    if !ok { return true }
    name := ""
    var metadata map[string]any
    switch fun := call.Fun.(type) {
    case *ast.Ident:
      name = fun.Name
    case *ast.SelectorExpr:
      name = strings.TrimSpace(nodeString(fset, fun))
      if receiverVar != "" {
        if base, ok := fun.X.(*ast.Ident); ok && base.Name == receiverVar {
          metadata = map[string]any{
            "call_kind": "receiver_method",
            "receiver_type": receiverType,
            "method": fun.Sel.Name,
          }
        } else if inner, ok := fun.X.(*ast.SelectorExpr); ok {
          if base, ok := inner.X.(*ast.Ident); ok && base.Name == receiverVar {
            fieldName := inner.Sel.Name
            metadata = map[string]any{
              "call_kind": "receiver_field_method",
              "receiver_type": receiverType,
              "receiver_field": fieldName,
              "method": fun.Sel.Name,
              "field_kind": "unknown",
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
    }
    if name == "" { return true }
    current, exists := byName[name]
    if !exists || (current.Metadata == nil && metadata != nil) {
      byName[name] = CallFact{Name: name, Metadata: metadata}
    }
    return true
  })
  names := make([]string, 0, len(byName))
  for name := range byName { names = append(names, name) }
  sort.Strings(names)
  facts := make([]CallFact, 0, len(names))
  for _, name := range names { facts = append(facts, byName[name]) }
  if len(names) > 100 { names = names[:100]; facts = facts[:100] }
  return names, facts
}

func main() {
  var req Request
  if err:=json.NewDecoder(bufio.NewReader(os.Stdin)).Decode(&req); err!=nil { fmt.Fprintln(os.Stderr,err); os.Exit(2) }
  enc:=json.NewEncoder(os.Stdout)
  for _,rel:=range req.Files {
    full:=filepath.Join(req.Root, filepath.FromSlash(rel)); src,err:=os.ReadFile(full); if err!=nil { enc.Encode(Result{FilePath:rel,Error:err.Error()}); continue }
    fset:=token.NewFileSet(); file,err:=parser.ParseFile(fset,full,src,parser.ParseComments); if err!=nil { enc.Encode(Result{FilePath:rel,Error:err.Error()}); continue }
    structs, interfaces := collectTypeFacts(fset, file)
    relID:=filepath.ToSlash(rel); pkg:=file.Name.Name; deps:=[]Dep{}
    for _,imp:=range file.Imports { deps=append(deps,Dep{FromFile:rel,Relation:"imports",ToRef:strings.Trim(imp.Path.Value,"\"")}) }
    syms:=[]Sym{}
    for _,decl:=range file.Decls {
      fn,ok:=decl.(*ast.FuncDecl); if !ok { continue }
      receiver:=recvName(fset,fn.Recv); q:=fn.Name.Name; kind:="function"; var recvPtr *string
      if receiver!="" { q=receiver+"."+fn.Name.Name; kind="method"; r:=receiver; recvPtr=&r }
      id:=fmt.Sprintf("go:%s::%s",relID,q)
      start:=fset.Position(fn.Pos()); end:=fset.Position(fn.End()); sOff:=start.Offset; eOff:=end.Offset; if sOff<0{sOff=0}; if eOff>len(src){eOff=len(src)}; if eOff<sOff{eOff=sOff}
      ps:=params(fset,fn.Type.Params); rs:=params(fset,fn.Type.Results); sig:=strings.TrimSpace(nodeString(fset,fn.Type)); doc:=""; source:="derived"; if fn.Doc!=nil { doc=strings.TrimSpace(fn.Doc.Text()); source="comment" }
      cs, callDeps:=callFacts(fset,fn,structs,interfaces); desc:=doc; if desc=="" { names:=[]string{}; for _,p:=range ps { if p.Name!="" {names=append(names,p.Name)} }; desc=fmt.Sprintf("%s(%s) in %s",q,strings.Join(names,", "),rel); if len(cs)>0 { max:=len(cs); if max>8{max=8}; desc += "; calls "+strings.Join(cs[:max],", ") }; desc += "." }
      sem,_:=json.Marshal(map[string]any{"name":q,"signature":sig,"params":ps,"returns":rs,"description":desc,"calls":cs}); semHash:=hashBytes(sem)
      syms=append(syms,Sym{SymbolID:id,FilePath:rel,Language:"go",Name:fn.Name.Name,QualifiedName:q,Kind:kind,Receiver:recvPtr,Signature:sig,Params:ps,Returns:rs,Description:desc,DescriptionSource:source,LineStart:start.Line,LineEnd:end.Line,ImplementationHash:hashBytes(src[sOff:eOff]),SemanticHash:semHash,Calls:cs})
      sid:=id; for _,call:=range callDeps { deps=append(deps,Dep{FromFile:rel,FromSymbolID:&sid,Relation:"calls",ToRef:call.Name,Metadata:call.Metadata}) }
    }
    enc.Encode(Result{FilePath:rel,Package:pkg,Symbols:syms,Dependencies:deps})
  }
}

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
type Sym struct {
  SymbolID string `json:"symbol_id"`; FilePath string `json:"file_path"`; Language string `json:"language"`;
  Name string `json:"name"`; QualifiedName string `json:"qualified_name"`; Kind string `json:"kind"`; Receiver *string `json:"receiver"`;
  Signature string `json:"signature"`; Params []Param `json:"params"`; Returns []Param `json:"returns"`; Description string `json:"description"`;
  DescriptionSource string `json:"description_source"`; LineStart int `json:"line_start"`; LineEnd int `json:"line_end"`;
  ImplementationHash string `json:"implementation_hash"`; SemanticHash string `json:"semantic_hash"`; Calls []string `json:"calls"`;
}
type Dep struct { FromFile string `json:"from_file"`; FromSymbolID *string `json:"from_symbol_id"`; Relation string `json:"relation"`; ToRef string `json:"to_ref"` }
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
func calls(fn *ast.FuncDecl) []string {
  set:=map[string]bool{}; out:=[]string{}
  if fn.Body==nil { return out }
  ast.Inspect(fn.Body, func(n ast.Node) bool {
    ce,ok:=n.(*ast.CallExpr); if !ok { return true }
    var name string
    switch f:=ce.Fun.(type) { case *ast.Ident: name=f.Name; case *ast.SelectorExpr: name=nodeString(token.NewFileSet(), f) }
    if name!="" && !set[name] { set[name]=true; out=append(out,name) }
    return true
  })
  sort.Strings(out); if len(out)>100 { out=out[:100] }; return out
}
func main() {
  var req Request
  if err:=json.NewDecoder(bufio.NewReader(os.Stdin)).Decode(&req); err!=nil { fmt.Fprintln(os.Stderr,err); os.Exit(2) }
  enc:=json.NewEncoder(os.Stdout)
  for _,rel:=range req.Files {
    full:=filepath.Join(req.Root, filepath.FromSlash(rel)); src,err:=os.ReadFile(full); if err!=nil { enc.Encode(Result{FilePath:rel,Error:err.Error()}); continue }
    fset:=token.NewFileSet(); file,err:=parser.ParseFile(fset,full,src,parser.ParseComments); if err!=nil { enc.Encode(Result{FilePath:rel,Error:err.Error()}); continue }
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
      cs:=calls(fn); desc:=doc; if desc=="" { names:=[]string{}; for _,p:=range ps { if p.Name!="" {names=append(names,p.Name)} }; desc=fmt.Sprintf("%s(%s) in %s",q,strings.Join(names,", "),rel); if len(cs)>0 { max:=len(cs); if max>8{max=8}; desc += "; calls "+strings.Join(cs[:max],", ") }; desc += "." }
      sem,_:=json.Marshal(map[string]any{"name":q,"signature":sig,"params":ps,"returns":rs,"description":desc,"calls":cs}); semHash:=hashBytes(sem)
      syms=append(syms,Sym{SymbolID:id,FilePath:rel,Language:"go",Name:fn.Name.Name,QualifiedName:q,Kind:kind,Receiver:recvPtr,Signature:sig,Params:ps,Returns:rs,Description:desc,DescriptionSource:source,LineStart:start.Line,LineEnd:end.Line,ImplementationHash:hashBytes(src[sOff:eOff]),SemanticHash:semHash,Calls:cs})
      sid:=id; for _,c:=range cs { deps=append(deps,Dep{FromFile:rel,FromSymbolID:&sid,Relation:"calls",ToRef:c}) }
    }
    enc.Encode(Result{FilePath:rel,Package:pkg,Symbols:syms,Dependencies:deps})
  }
}

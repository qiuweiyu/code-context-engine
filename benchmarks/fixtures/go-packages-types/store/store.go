package store

func Fetch(id int) int { return id }

type Box[T any] struct { Value T }
func NewBox[T any](value T) Box[T] { return Box[T]{Value: value} }
func (b Box[T]) Get() T { return b.Value }

type Reader interface { Read() string }
type FileReader struct{}
func (FileReader) Read() string { return "file" }

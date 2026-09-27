package service

import "example.com/ccefixture/store"

func Load() int { return store.Fetch(7) }

func Generic() int {
  box := store.NewBox[int](3)
  return box.Get()
}

func ViaInterface(reader store.Reader) string {
  return reader.Read()
}

package main

import (
	"fmt"
	"os"
)

func main() {
	if len(os.Args) < 2 {
		panic("usage: server <addr>")
	}
	fmt.Println("listening on", os.Args[1])
}

// Fixture (W18-07): os.ReadFile, the replacement; ioutil.ReadFile only in this comment.
package main

import (
	"fmt"
	"os"
)

func main() {
	data, err := os.ReadFile("config.json")
	fmt.Println(len(data), err)
}

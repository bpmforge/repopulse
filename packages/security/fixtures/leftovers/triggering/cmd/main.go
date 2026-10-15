// Fixture (W18-07): io/ioutil, deprecated since Go 1.16.
package main

import (
	"fmt"
	"io/ioutil"
)

func main() {
	data, err := ioutil.ReadFile("config.json")
	fmt.Println(len(data), err)
}

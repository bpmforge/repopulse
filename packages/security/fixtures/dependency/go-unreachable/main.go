package main

import (
	"fmt"

	jwt "github.com/dgrijalva/jwt-go"
)

func main() {
	t := jwt.New(jwt.SigningMethodHS256)
	fmt.Println(t.Method.Alg())
}

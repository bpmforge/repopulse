package main

import (
	"fmt"

	jwt "github.com/dgrijalva/jwt-go"
)

func main() {
	claims := jwt.MapClaims{"aud": []string{"a", "b"}}
	fmt.Println(claims.VerifyAudience("a", false))
}

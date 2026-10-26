module example.com/svc

go 1.23

require (
	github.com/stretchr/testify v1.9.0
	github.com/gin-gonic/gin v1.10.0
	github.com/boltdb-go/bolt v1.3.1
	github.com/example-hallucinated/httpkit v0.4.0
	example.com/local v0.0.0
)

replace example.com/local => ./local

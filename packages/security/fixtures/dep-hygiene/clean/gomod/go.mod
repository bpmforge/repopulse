module example.com/gomod

go 1.22

require (
	github.com/onsi/ginkgo/v2 v2.19.0
	github.com/stretchr/testify v1.9.0
	go.uber.org/zap v1.27.0
	gopkg.in/check.v1 v1.0.0-20201130134442-10cb98267c6c
	k8s.io/klog/v2 v2.130.1
)

require github.com/sirupsen/logrus v1.9.3 // indirect

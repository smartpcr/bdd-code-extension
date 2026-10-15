// Package actions holds the demo binding's actions.
package actions

import "fmt"

// Request is what a handler is given.
type Request struct {
	Params map[string]any
}

// Handler runs one step.
type Handler func(request *Request) (any, error)

// Failed reports a step failure.
func Failed(message string) error { return fmt.Errorf("%s", message) }

// Registry maps each action name to its handler.
func Registry() map[string]Handler {
	return map[string]Handler{
		"demo.greet": demoGreet,
		"demo.count": demoCount,
	}
}

func demoGreet(request *Request) (any, error) {
	return map[string]any{"greeting": fmt.Sprintf("Hello, %v", request.Params["name"])}, nil
}

func demoCount(request *Request) (any, error) {
	to, _ := request.Params["to"].(int)
	counted := []int{}
	for i := 1; i <= to; i++ {
		counted = append(counted, i)
	}
	return map[string]any{"counted": counted}, nil
}

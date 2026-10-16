// Package actions is the shop's actions, Go binding. Every handler is small
// and deterministic, and returns what the other four bindings return for the
// same step, so one suite gives one result everywhere.
package actions

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/actions"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/model"
)

// Registrations is every action this binding implements.
var Registrations = []actions.Registration{
	{Name: "inventory.get", Handler: inventoryGet},
	{Name: "cart.add", Handler: cartAdd},
	{Name: "order.place", Handler: orderPlace},
	{Name: "price.quote", Handler: priceQuote},
	{Name: "stock.reserve", Handler: stockReserve},
	{Name: "shipping.quote", Handler: shippingQuote},
	{Name: "customer.lookup", Handler: customerLookup},
	{Name: "audit.log", Handler: auditLog},
}

// text is a required text parameter.
func text(request *actions.Request, name string) (string, error) {
	value, found := request.Step.Get(name)
	if !found || value == nil || fmt.Sprint(value) == "" {
		return "", actions.Failed(fmt.Sprintf("%s needs a %s.", request.Action, name))
	}
	return fmt.Sprint(value), nil
}

// integer is an integer parameter, given as a number or as a numeric string.
func integer(request *actions.Request, name string, fallback int64) (int64, error) {
	value, found := request.Step.Get(name)
	if !found || value == nil {
		return fallback, nil
	}
	switch held := value.(type) {
	case int64:
		return held, nil
	case int:
		return int64(held), nil
	case float64:
		return int64(held), nil
	}
	parsed, err := strconv.ParseInt(strings.TrimSpace(fmt.Sprint(value)), 10, 64)
	if err != nil {
		return 0, actions.Failed(fmt.Sprintf("%s: %s is not a whole number.", request.Action, name))
	}
	return parsed, nil
}

func object(pairs ...any) *model.Map {
	out := model.NewMap()
	for i := 0; i+1 < len(pairs); i += 2 {
		out.Set(pairs[i].(string), pairs[i+1])
	}
	return out
}

func inventoryGet(request *actions.Request) (any, error) {
	sku, err := text(request, "sku")
	if err != nil {
		return nil, err
	}
	return object("sku", sku, "quantity", int64(len(sku)*10), "inStock", true), nil
}

func skuAndQuantity(request *actions.Request) (string, int64, error) {
	sku, err := text(request, "sku")
	if err != nil {
		return "", 0, err
	}
	quantity, err := integer(request, "quantity", 1)
	return sku, quantity, err
}

func cartAdd(request *actions.Request) (any, error) {
	sku, quantity, err := skuAndQuantity(request)
	if err != nil {
		return nil, err
	}
	return object("sku", sku, "quantity", quantity, "line", fmt.Sprintf("%sx%d", sku, quantity)), nil
}

func orderPlace(request *actions.Request) (any, error) {
	sku, quantity, err := skuAndQuantity(request)
	if err != nil {
		return nil, err
	}
	return object("orderId", fmt.Sprintf("ORD-%s-%d", sku, quantity), "status", "placed"), nil
}

func priceQuote(request *actions.Request) (any, error) {
	sku, quantity, err := skuAndQuantity(request)
	if err != nil {
		return nil, err
	}
	return object("sku", sku, "total", quantity*3), nil
}

func stockReserve(request *actions.Request) (any, error) {
	sku, quantity, err := skuAndQuantity(request)
	if err != nil {
		return nil, err
	}
	return object("sku", sku, "reserved", quantity), nil
}

func shippingQuote(request *actions.Request) (any, error) {
	weight, err := integer(request, "weightKg", 0)
	if err != nil {
		return nil, err
	}
	if weight <= 0 {
		return nil, actions.Failed("shipping.quote needs a weightKg above zero.")
	}
	policy := "Standard"
	if given, found := request.Step.Get("policy"); found && given != nil && fmt.Sprint(given) != "" {
		policy = fmt.Sprint(given)
	}
	var rate int64
	switch policy {
	case "Standard":
		rate = 5
	case "Express":
		rate = 10
	default:
		return nil, actions.Failed(fmt.Sprintf("shipping.quote: unknown policy %s.", policy))
	}
	return object("policy", policy, "cost", weight*rate), nil
}

func customerLookup(request *actions.Request) (any, error) {
	id, err := text(request, "id")
	if err != nil {
		return nil, err
	}
	tier := "standard"
	if strings.HasPrefix(id, "G") {
		tier = "gold"
	}
	return object("id", id, "name", "Customer "+id, "tier", tier), nil
}

func auditLog(request *actions.Request) (any, error) {
	if _, err := text(request, "message"); err != nil {
		return nil, err
	}
	return object("logged", true), nil
}

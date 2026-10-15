package spelling

import "testing"

func TestDistanceCountsEditsAndIgnoresCase(t *testing.T) {
	for _, row := range []struct {
		left, right string
		want        int
	}{
		{"asserts", "asserts", 0},
		{"ASSERTS", "asserts", 0},
		{"assert", "asserts", 1},
		{"assrets", "asserts", 2},
		{"", "abc", 3},
		{"abc", "", 3},
		{"", "", 0},
	} {
		if got := Distance(row.left, row.right); got != row.want {
			t.Errorf("Distance(%q,%q) = %d, wanted %d", row.left, row.right, got, row.want)
		}
	}
}

func TestANearMissIsSuggested(t *testing.T) {
	keys := []string{"asserts", "steps", "name", "tags"}
	if got := Nearest("assert", keys, 2); got != "asserts" {
		t.Errorf("assert -> %q", got)
	}
	if got := Nearest("stepz", keys, 2); got != "steps" {
		t.Errorf("stepz -> %q", got)
	}
	if got := Nearest("nothinglikeit", keys, 2); got != "" {
		t.Errorf("nothinglikeit -> %q", got)
	}
}

func TestAPrefixIsSuggestedWhenNothingIsNearEnough(t *testing.T) {
	keys := []string{"timeoutSec", "cleanupTimeoutSec", "name"}
	if got := Nearest("timeout", keys, 2); got != "timeoutSec" {
		t.Errorf("timeout -> %q", got)
	}
	if got := Nearest("cleanupTimeout", keys, 2); got != "cleanupTimeoutSec" {
		t.Errorf("cleanupTimeout -> %q", got)
	}
	// Three shared characters is not a signal: too many names start with the
	// same three letters for that to mean anything.
	if got := Nearest("tim", []string{"timeoutSec"}, 2); got != "" {
		t.Errorf("tim -> %q", got)
	}
}

func TestATieGoesToTheNameThatSortsFirst(t *testing.T) {
	if got := Nearest("aaa", []string{"aab", "aac"}, 2); got != "aab" {
		t.Errorf("-> %q", got)
	}
	if got := Nearest("aaa", []string{"aac", "aab"}, 2); got != "aab" {
		t.Errorf("-> %q", got)
	}
}

func TestNothingSuggestsNothing(t *testing.T) {
	if Nearest("", []string{"a"}, 2) != "" || Nearest("a", nil, 2) != "" || Nearest("a", []string{""}, 2) != "" {
		t.Error("nothing suggested something")
	}
}

func TestAWiderDistanceReachesFurther(t *testing.T) {
	if Nearest("restrat", []string{"fixture.restart"}, 2) != "" {
		t.Error("two edits reached too far")
	}
	if got := Nearest("fixture.restrat", []string{"fixture.restart"}, 3); got != "fixture.restart" {
		t.Errorf("-> %q", got)
	}
}

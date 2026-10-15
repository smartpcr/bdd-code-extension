// Package spelling turns "unknown key" into "did you mean asserts".
//
// Two rules, in order. The nearest candidate within an edit distance, which
// catches a transposition, a doubled letter and a dropped one. Then, when
// nothing is near enough, the shortest candidate that one of the two is a
// prefix of: `timeout` for `timeoutSec` is three edits away and so is
// `cleanupTimeout` for `cleanupTimeoutSec`, and those are the two mistakes this
// format invites most.
package spelling

import (
	"sort"
	"strings"
)

// Distance is the Levenshtein distance between two words, ignoring case.
func Distance(left, right string) int {
	one := []rune(strings.ToLower(left))
	other := []rune(strings.ToLower(right))
	if string(one) == string(other) {
		return 0
	}
	if len(one) == 0 {
		return len(other)
	}
	if len(other) == 0 {
		return len(one)
	}
	previous := make([]int, len(other)+1)
	current := make([]int, len(other)+1)
	for index := range previous {
		previous[index] = index
	}
	for i, leftRune := range one {
		current[0] = i + 1
		for j, rightRune := range other {
			cost := 1
			if leftRune == rightRune {
				cost = 0
			}
			current[j+1] = min3(current[j]+1, previous[j+1]+1, previous[j]+cost)
		}
		previous, current = current, previous
	}
	return previous[len(other)]
}

func min3(one, two, three int) int {
	smallest := one
	if two < smallest {
		smallest = two
	}
	if three < smallest {
		smallest = three
	}
	return smallest
}

// Nearest is the nearest legal spelling, or nothing.
func Nearest(word string, candidates []string, maxDistance int) string {
	if word == "" {
		return ""
	}
	best := ""
	bestDistance := maxDistance + 1
	for _, candidate := range candidates {
		if candidate == "" {
			continue
		}
		distance := Distance(word, candidate)
		if distance > maxDistance {
			continue
		}
		// A tie goes to the name that sorts first, so two runs suggest the same
		// thing whatever order the candidates arrived in.
		if best == "" || distance < bestDistance || (distance == bestDistance && candidate < best) {
			best = candidate
			bestDistance = distance
		}
	}
	if best != "" {
		return best
	}

	byLength := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		if candidate != "" {
			byLength = append(byLength, candidate)
		}
	}
	sort.SliceStable(byLength, func(one, other int) bool {
		if len(byLength[one]) != len(byLength[other]) {
			return len(byLength[one]) < len(byLength[other])
		}
		return byLength[one] < byLength[other]
	})
	lower := strings.ToLower(word)
	for _, candidate := range byLength {
		other := strings.ToLower(candidate)
		shared := len(lower)
		if len(other) < shared {
			shared = len(other)
		}
		if shared < 4 {
			continue
		}
		if strings.HasPrefix(other, lower) || strings.HasPrefix(lower, other) {
			return candidate
		}
	}
	return ""
}

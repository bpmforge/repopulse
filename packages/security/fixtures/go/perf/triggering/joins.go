package perf

import "slices"

// Algorithmic shapes, Go (W21-20).

type Link struct {
	Index int
	Name  string
}

type Route struct{ OutIface int }

func names(routes []Route, links []Link) []string {
	out := []string{}
	for _, r := range routes {
		for _, l := range links {
			if l.Index == r.OutIface {
				out = append(out, l.Name)
			}
		}
	}
	return out
}

func kept(all []string, excludes []string) []string {
	out := []string{}
	for _, c := range all {
		if !slices.Contains(excludes, c) {
			out = append(out, c)
		}
	}
	return out
}

func reversed(in []int) []int {
	out := []int{}
	for _, v := range in {
		out = append([]int{v}, out...)
	}
	return out
}

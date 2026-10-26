package perf

import "slices"

// The same jobs in linear time (W21-20).

type Link struct {
	Index int
	Name  string
}

type Route struct{ OutIface int }

func names(routes []Route, links []Link) []string {
	byIndex := make(map[int]string, len(links))
	for _, l := range links {
		byIndex[l.Index] = l.Name
	}
	out := []string{}
	for _, r := range routes {
		if n, ok := byIndex[r.OutIface]; ok {
			out = append(out, n)
		}
	}
	return out
}

func kept(all []string, excludes []string) []string {
	skip := make(map[string]struct{}, len(excludes))
	for _, e := range excludes {
		skip[e] = struct{}{}
	}
	out := []string{}
	for _, c := range all {
		if _, ok := skip[c]; !ok {
			out = append(out, c)
		}
	}
	return out
}

func reversed(in []int) []int {
	out := append([]int{}, in...)
	slices.Reverse(out)
	return out
}

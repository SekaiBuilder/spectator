package main

import "fmt"

const MaxItems = 50

func Process(items []int) int {
	total := 0
	for _, i := range items {
		if i > 100 {
			total += i
		}
	}
	return total
}

func main() { fmt.Println(Process(nil)) }

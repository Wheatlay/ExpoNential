//go:build !windows

package app

import "fmt"

const (
	idYes    = 6
	dlgInfo  = 0
	dlgError = 1
	dlgAsk   = 2
)

// msgBox prints the text (no native dialog on this OS); questions are answered "yes".
func msgBox(text string, kind uint32) int {
	fmt.Println(text)
	return idYes
}

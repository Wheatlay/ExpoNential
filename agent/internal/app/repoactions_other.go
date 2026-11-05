//go:build !windows

package app

import "errors"

func pickRepoFolder(title string) (string, error) {
	return "", errors.New("not supported")
}

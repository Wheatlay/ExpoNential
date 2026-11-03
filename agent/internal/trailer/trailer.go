// Package trailer reads the config the server appends to the downloaded exe:
// [JSON bytes][uint32 little-endian JSON length]["EXPCFG01"].
package trailer

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"os"
)

const magic = "EXPCFG01"
const maxJSON = 64 * 1024

type Config struct {
	URL     string `json:"url"`
	Pairing string `json:"pairing"`
	Engine  string `json:"engine,omitempty"` // claude | codex, chosen in the web wizard
}

// Parse returns the trailer and its total size in bytes (JSON + 4 + 8), or an error when there is none.
func Parse(r io.ReaderAt, size int64) (Config, int64, error) {
	var c Config
	if size < 12 {
		return c, 0, errors.New("no trailer")
	}
	tail := make([]byte, 12)
	if _, err := r.ReadAt(tail, size-12); err != nil {
		return c, 0, err
	}
	if !bytes.Equal(tail[4:], []byte(magic)) {
		return c, 0, errors.New("no trailer")
	}
	n := int64(binary.LittleEndian.Uint32(tail[:4]))
	if n == 0 || n > maxJSON || n+12 > size {
		return c, 0, errors.New("bad trailer length")
	}
	buf := make([]byte, n)
	if _, err := r.ReadAt(buf, size-12-n); err != nil {
		return c, 0, err
	}
	if err := json.Unmarshal(buf, &c); err != nil {
		return c, 0, err
	}
	return c, n + 12, nil
}

// ReadFile reads the trailer of the file at path.
func ReadFile(path string) (Config, int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return Config{}, 0, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return Config{}, 0, err
	}
	return Parse(f, st.Size())
}

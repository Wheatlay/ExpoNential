package app

import (
	"crypto/ed25519"
	"encoding/base64"
	"testing"
)

func TestVerifySumsSig(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(nil)
	sums := []byte("abc  exponential-agent.exe\n")
	sig := []byte(base64.StdEncoding.EncodeToString(ed25519.Sign(priv, sums)) + "\n")
	if err := verifySumsSig(pub, sums, sig); err != nil {
		t.Fatal(err)
	}
	if verifySumsSig(pub, []byte("tampered\n"), sig) == nil {
		t.Error("tampered sums accepted")
	}
	if verifySumsSig(pub, sums, []byte("not base64!!")) == nil {
		t.Error("garbage signature accepted")
	}
	if verifySumsSig(pub, sums, nil) == nil {
		t.Error("missing signature accepted")
	}
	other, _, _ := ed25519.GenerateKey(nil)
	if verifySumsSig(other, sums, sig) == nil {
		t.Error("wrong key accepted")
	}
}

func TestEmbeddedKeyLength(t *testing.T) {
	if len(embeddedKey()) != ed25519.PublicKeySize {
		t.Fatal("embedded update key is not 32 bytes")
	}
}

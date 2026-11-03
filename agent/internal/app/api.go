package app

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

type HttpError struct {
	Status int
	Msg    string
}

func (e *HttpError) Error() string { return e.Msg }

type Auth struct{ Base, Auth string }

func httpDo(method, full string, headers map[string]string, body []byte, timeout time.Duration) (int, []byte, error) {
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	}
	req, err := http.NewRequest(method, full, rd)
	if err != nil {
		return 0, nil, err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := (&http.Client{Timeout: timeout}).Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer res.Body.Close()
	b, err := io.ReadAll(res.Body)
	return res.StatusCode, b, err
}

// oauthPost: form-encoded per RFC 6749/8628, or JSON for registration.
func oauthPost(base, path string, body map[string]any, asJSON bool) (map[string]any, error) {
	var payload []byte
	ct := "application/x-www-form-urlencoded"
	if asJSON {
		ct = "application/json"
		payload, _ = json.Marshal(body)
	} else {
		v := url.Values{}
		for k, x := range body {
			v.Set(k, fmt.Sprint(x))
		}
		payload = []byte(v.Encode())
	}
	status, text, err := httpDo("POST", base+path, map[string]string{"Content-Type": ct, "Accept": "application/json"}, payload, 30*time.Second)
	if err != nil {
		return nil, err
	}
	j := map[string]any{}
	if len(text) > 0 {
		_ = json.Unmarshal(text, &j)
	}
	if (status < 200 || status > 299) && !truthy(j["error"]) {
		return nil, &HttpError{status, fmt.Sprintf("%s: HTTP %d", path, status)}
	}
	return j, nil
}

func truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case string:
		return x != ""
	case bool:
		return x
	case float64:
		return x != 0
	}
	return true
}

func str(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

func num(v any) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case string:
		var f float64
		fmt.Sscan(x, &f)
		return f
	}
	return 0
}

func nowMs() float64 { return float64(time.Now().UnixMilli()) }

var authMu sync.Mutex

// getAuth returns base URL and Authorization header from config; refreshes an expired OAuth access token. nil = not logged in.
func getAuth() (*Auth, error) {
	authMu.Lock()
	defer authMu.Unlock()
	cfg := loadConfig()
	if cfg.URL == "" {
		return nil, nil
	}
	base := strings.TrimRight(cfg.URL, "/")
	if cfg.Token != "" {
		return &Auth{base, "Bearer " + cfg.Token}, nil
	}
	o := cfg.OAuth
	if o == nil {
		return nil, nil
	}
	if o.ExpiresAt-60000 > nowMs() {
		return &Auth{base, "Bearer " + o.Access}, nil
	}
	r, err := oauthPost(base, "/oauth/token", map[string]any{"grant_type": "refresh_token", "refresh_token": o.Refresh, "client_id": o.ClientID}, false)
	if err != nil {
		return nil, err
	}
	at := str(r["access_token"])
	if at == "" {
		e := str(r["error"])
		if e == "" {
			e = "unknown"
		}
		return nil, fmt.Errorf("Token refresh failed (%s), run: exponential-agent login", e)
	}
	refresh := str(r["refresh_token"])
	if refresh == "" {
		refresh = o.Refresh
	}
	exp := num(r["expires_in"])
	if exp == 0 {
		exp = 3600
	}
	updateConfig(func(c *Config) {
		c.OAuth = &OAuth{Access: at, Refresh: refresh, ExpiresAt: nowMs() + exp*1000, ClientID: o.ClientID}
	})
	return &Auth{base, "Bearer " + at}, nil
}

// request does an authenticated JSON call; out (optional) receives the decoded body.
func request(a *Auth, method, path string, body any, timeout time.Duration, out any) error {
	var payload []byte
	if body != nil {
		payload, _ = json.Marshal(body)
	}
	if timeout == 0 {
		timeout = 60 * time.Second
	}
	status, text, err := httpDo(method, a.Base+path, map[string]string{"Authorization": a.Auth, "Content-Type": "application/json; charset=utf-8", "Accept": "application/json"}, payload, timeout)
	if err != nil {
		return err
	}
	if status < 200 || status > 299 {
		msg := ""
		var e struct {
			Error any `json:"error"`
		}
		if json.Unmarshal(text, &e) == nil && e.Error != nil {
			msg = fmt.Sprint(e.Error)
			if len(msg) > 150 {
				msg = msg[:150]
			}
		}
		// Without the query string: it carries the device id and repo map, which say nothing in Settings.
		m := fmt.Sprintf("%s %s: HTTP %d", method, strings.SplitN(path, "?", 2)[0], status)
		if msg != "" {
			m += " " + msg
		}
		return &HttpError{status, m}
	}
	if out != nil && len(bytes.TrimSpace(text)) > 0 {
		return json.Unmarshal(text, out)
	}
	return nil
}

func httpStatus(err error) int {
	var he *HttpError
	if errors.As(err, &he) {
		return he.Status
	}
	return 0
}

type Project struct {
	Key        string  `json:"key"`
	GithubRepo *string `json:"githubRepo"`
}

func (p *Project) repo() string {
	if p == nil || p.GithubRepo == nil {
		return ""
	}
	return *p.GithubRepo
}

func listProjects(a *Auth) ([]Project, error) {
	var l []Project
	err := request(a, "GET", "/api/projects", nil, 0, &l)
	return l, err
}

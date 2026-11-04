package app

import "strings"

// uiCSS is the shared colour block of every agent window. The values mirror the dark and light theme blocks
// of src/web/styles.css (keep them in step with it). Pages choose the block with <html data-theme="dark|light">.
const uiCSS = `
:root[data-theme="dark"] {
  --bg-primary: lch(5.52% 0.4 272); --bg-secondary: lch(7.32% 0.85 272); --bg-tertiary: lch(8.22% 1.3 272); --bg-hover: lch(11% 1.3 272);
  --bg-popover: lch(9.5% 1.3 272);
  --border-primary: lch(9.84% 1.48 272); --border-secondary: lch(14.16% 1.48 272); --border-tertiary: lch(18% 1.48 272);
  --text-primary: lch(100% 0 272); --text-secondary: lch(90.451% 1.2 272); --text-tertiary: lch(61.803% 1.2 272);
  --accent: #5e6ad2; --accent-hover: #7180ff; --accent-text: #aab0ff; --on-accent: #ffffff;
  --danger: #eb5757; --danger-text: #f87171;
  --success: #4cb782; --success-text: #4cb782;
  --warning: #f2994a; --warning-text: #f2b06a;
  --progress: #f2c94c; --progress-text: #f2c94c;
  --ai: #a855f7; --ai-text: #c084fc;
  --info: #3b82f6; --info-text: #93c5fd;
  --shadow-popover: 0 8px 30px rgb(0 0 0 / 0.5), 0 0 0 1px var(--border-secondary);
  color-scheme: dark;
}
:root[data-theme="oled"] {
  --bg-primary: #000; --bg-secondary: #000; --bg-tertiary: #0a0a0b; --bg-hover: #141416;
  --bg-popover: #000;
  --border-primary: lch(14% 1.48 272); --border-secondary: lch(20% 1.48 272); --border-tertiary: lch(25% 1.48 272);
  --text-primary: lch(100% 0 272); --text-secondary: lch(90.451% 1.2 272); --text-tertiary: lch(61.803% 1.2 272);
  --accent: #5e6ad2; --accent-hover: #7180ff; --accent-text: #aab0ff; --on-accent: #ffffff;
  --danger: #eb5757; --danger-text: #f87171;
  --success: #4cb782; --success-text: #4cb782;
  --warning: #f2994a; --warning-text: #f2b06a;
  --progress: #f2c94c; --progress-text: #f2c94c;
  --ai: #a855f7; --ai-text: #c084fc;
  --info: #3b82f6; --info-text: #93c5fd;
  --shadow-popover: 0 8px 30px rgb(0 0 0 / 0.5), 0 0 0 1px var(--border-secondary);
  color-scheme: dark;
}
:root[data-theme="light"] {
  --bg-primary: lch(98.5% 0.5 282); --bg-secondary: lch(96% 0.5 282); --bg-tertiary: lch(92.44% 0.5 282); --bg-hover: lch(92.5% 0.5 282);
  --bg-popover: #fff;
  --border-primary: lch(93% 0 282); --border-secondary: lch(88.49% 0 282); --border-tertiary: lch(84.44% 0 282);
  --text-primary: lch(9.794% 0 282); --text-secondary: lch(19.588% 1.25 282); --text-tertiary: lch(39.176% 1.25 282);
  --accent: #5e6ad2; --accent-hover: #7180ff; --accent-text: #4f5bd5; --on-accent: #ffffff;
  --danger: #dc4545; --danger-text: #c42b2b;
  --success: #2f9e6b; --success-text: #17784d;
  --warning: #e8862e; --warning-text: #b45309;
  --progress: #d9a400; --progress-text: #8a6d00;
  --ai: #9333ea; --ai-text: #7e22ce;
  --info: #2563eb; --info-text: #1d4ed8;
  --shadow-popover: 0 8px 24px rgb(0 0 0 / 0.12), 0 0 0 1px var(--border-secondary);
  color-scheme: light;
}
`

// applyUI fills the placeholders of a page: {{THEME}} and the /*{{CSS}}*/ marker.
func applyUI(page, theme string) string {
	if theme != "light" && theme != "oled" {
		theme = "dark"
	}
	return strings.NewReplacer("{{THEME}}", theme, "/*{{CSS}}*/", uiCSS).Replace(page)
}

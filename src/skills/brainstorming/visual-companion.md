# Visual Companion Guide

Browser-based visual brainstorming companion for showing mockups, diagrams, and options.

## When to Use

Decide per-question, not per-session. The test: **would the user understand this better by seeing it than reading it?**

**Use the browser** when the content itself is visual:

- **UI mockups** — wireframes, layouts, navigation structures, component designs
- **Architecture diagrams** — system components, data flow, relationship maps
- **Side-by-side visual comparisons** — comparing two layouts, two color schemes, two design directions
- **Design polish** — when the question is about look and feel, spacing, visual hierarchy
- **Spatial relationships** — state machines, flowcharts, entity relationships rendered as diagrams

**Use the terminal** when the content is text or tabular:

- **Requirements and scope questions** — "what does X mean?", "which features are in scope?"
- **Conceptual A/B/C choices** — picking between approaches described in words
- **Tradeoff lists** — pros/cons, comparison tables
- **Technical decisions** — API design, data modeling, architectural approach selection
- **Clarifying questions** — anything where the answer is words, not a visual preference

## How It Works

The server watches a directory for HTML files and serves the newest one to the browser. You write HTML content to `screen_dir`, the user sees it in their browser and can click to select options. Selections are recorded to `state_dir/events` that you read on your next turn.

**Content fragments vs full documents:** If your HTML file starts with `<!DOCTYPE` or `<html`, it's served as-is. Otherwise it's wrapped in the frame template which provides theming, header, indicator bar, and CSS helpers.

## Starting the Server

```bash
scripts/start-server.sh --project-dir /path/to/project
```

Returns JSON with `url`, `screen_dir`, and `state_dir`.

## Showing Content

Write an HTML file to `screen_dir`:

```bash
cat > "$SCREEN_DIR/question-1.html" << 'SCREEN_EOF'
<h2>Which layout works better?</h2>
<p class="subtitle">Consider readability and visual hierarchy</p>

<div class="options">
  <div class="option" data-choice="a" onclick="toggleSelect(this)">
    <div class="letter">A</div>
    <div class="content">
      <h3>Single Column</h3>
      <p>Clean, focused reading experience</p>
    </div>
  </div>
  <div class="option" data-choice="b" onclick="toggleSelect(this)">
    <div class="letter">B</div>
    <div class="content">
      <h3>Two Column</h3>
      <p>Sidebar navigation with main content</p>
    </div>
  </div>
</div>
SCREEN_EOF
```

## Reading User Selections

```bash
cat "$STATE_DIR/events"
```

## CSS Helpers

The frame template provides these classes:

- `.options` / `.option` — A/B/C choice lists
- `.cards` / `.card` — grid of visual cards
- `.mockup` / `.mockup-header` / `.mockup-body` — mockup containers
- `.split` — side-by-side comparison
- `.pros-cons` / `.pros` / `.cons` — pros/cons grid
- `.mock-nav`, `.mock-sidebar`, `.mock-content` — inline mockup elements
- `.placeholder` — dashed placeholder area

## Stopping the Server

```bash
scripts/stop-server.sh $SESSION_DIR
```

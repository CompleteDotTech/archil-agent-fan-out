# Workflow diagrams

The README and architecture guide use committed PNGs so the diagrams display without a Mermaid plugin. Edit the adjacent `.mmd` files, then regenerate the images. Violet marks coordination and checks, cyan marks workers, green marks delivery, orange marks interruption or failure, and slate marks persistent context. Every state also has a text label.

| Diagram | Editable source | Rendered image |
| --- | --- | --- |
| Brief to delivery | [overview.mmd](overview.mmd) | [overview.png](overview.png) |
| Template and parallel workers | [parallel-workers.mmd](parallel-workers.mmd) | [parallel-workers.png](parallel-workers.png) |
| Verification and integration | [verification-gate.mmd](verification-gate.mmd) | [verification-gate.png](verification-gate.png) |
| Stop and resume | [stop-resume.mmd](stop-resume.mmd) | [stop-resume.png](stop-resume.png) |

## Render

Use Node.js and Mermaid CLI 11.12.0. The renderer is installed separately from the application dependencies:

```bash
PUPPETEER_SKIP_DOWNLOAD=1 npm install --prefix /tmp/archil-mermaid-tools --no-audit --no-fund @mermaid-js/mermaid-cli@11.12.0
MMDC=/tmp/archil-mermaid-tools/node_modules/.bin/mmdc \
  PUPPETEER_CONFIG=/absolute/path/to/puppeteer.json \
  bash docs/diagrams/render.sh
```

Point Puppeteer at an installed Chromium browser with a JSON configuration such as:

```json
{"executablePath":"/usr/bin/chromium"}
```

Alternatively, use a Mermaid CLI installation with its bundled browser and omit `PUPPETEER_CONFIG`. `MMDC` defaults to `mmdc`. The shared theme is in [mermaid-config.json](mermaid-config.json); PNGs render at twice the layout resolution on a white background. Run the script from any directory. Check all four images after changing layout or labels.

The diagrams describe the design in [PLAN.md](../PLAN.md). The gate and recovery flows also reflect the implementation: integration failures become blocked, and automatic resumes have a configured limit.

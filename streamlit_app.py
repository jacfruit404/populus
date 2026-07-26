"""
Streamlit deploy adapter for Populus — hosting only, no logic.

Populus is a dependency-free static app (index.html + engine.js). This wrapper
exists so it can be hosted on Streamlit Community Cloud and shared as a link;
it adds no behaviour. It reads the two source files, inlines engine.js into the
page (the component iframe can't resolve the external <script src>), and renders
the result full-bleed. The app is untouched and still runs locally via
./serve.sh with no Python involved.

The ledger falls back to per-browser storage here (there is no /api/ledger to
write to), and the local-model panel shows its "shared link" note, because the
model endpoint always points at the *viewer's* own machine.
"""
from pathlib import Path

import streamlit as st
import streamlit.components.v1 as components

st.set_page_config(page_title="Populus", layout="wide",
                   initial_sidebar_state="collapsed")

# Hide Streamlit's own chrome and padding so the app owns the whole viewport.
st.markdown(
    "<style>"
    "header[data-testid='stHeader']{display:none}"
    "div[data-testid='stAppViewBlockContainer'],"
    "div[data-testid='stMainBlockContainer']{padding:0;max-width:100%}"
    ".stApp iframe{width:100%;border:0}"
    "</style>",
    unsafe_allow_html=True,
)

root = Path(__file__).parent
html = (root / "index.html").read_text(encoding="utf-8")
engine = (root / "engine.js").read_text(encoding="utf-8")

# The page loads the engine with <script src="engine.js">, which the component
# iframe can't fetch. Inline the file verbatim in its place instead.
src_tag = '<script src="engine.js"></script>'
if src_tag not in html:
    raise RuntimeError("expected the engine <script src> tag in index.html; "
                       "the adapter needs updating if index.html changed")
html = html.replace(src_tag, "<script>\n" + engine + "\n</script>")

# Fixed-height iframe: components.html can't auto-size, so give it room. The app
# manages its own internal scrolling; this is the outer bound.
components.html(html, height=1000, scrolling=True)

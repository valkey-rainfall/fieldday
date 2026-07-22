# Gallery

Annotated layout JSONs for published diagrams — one directory per
deliverable. These are the *sources*; rendered SVGs are build artifacts
and live in their destination (blog repo, slide deck), not here.
Regenerate any diagram with:

    fieldday --from-json <file>.json --px-per-byte <scale> [--responsive]

Some gallery files double as CI fixtures: the Python/JS renderer parity
check renders them through both implementations on every push.

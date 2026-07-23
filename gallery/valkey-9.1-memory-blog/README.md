# Valkey 9.1 memory efficiency blog (valkey-io.github.io PR 594)

Before/after pairs for the embstr ptr-reuse and skiplist member
embedding stories. Render at matched scale:

    fieldday --from-json embstr_pair.json --px-per-byte 14 --cache-line 0
    fieldday --from-json zslnode_pair.json --px-per-byte 14 --cache-line 0
    fieldday --from-json threshold_pair.json --px-per-byte 3.5 --jemalloc-slack --cache-line 0

Cache-line rules are disabled: cache locality is not part of this
post's narrative.

The threshold pair renders at 3.5 px/byte with robj internals
collapsed to a single "robj header" block: valkey.io caps post
images at 720px, and this section's story is allocation count and
jemalloc round-up, not robj fields (the embstr pair already shows
them in full). At this scale the figures display near-native size
instead of being scaled to ~50%.

# Valkey 9.1 memory efficiency blog (valkey-io.github.io PR 594)

Before/after pairs for the embstr ptr-reuse and skiplist member
embedding stories. Render at matched scale:

    fieldday --from-json embstr_pair.json --px-per-byte 14 --cache-line 0
    fieldday --from-json zslnode_pair.json --px-per-byte 14 --cache-line 0
    fieldday --from-json threshold_pair.json --px-per-byte 7 --jemalloc-slack --cache-line 0

Cache-line rules are disabled: cache locality is not part of this
post's narrative.

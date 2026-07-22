/* Valkey 9.1 (PR 2508): element embedded after level[] -- one allocation */
typedef struct zskiplistNode {
    double score;
    struct zskiplistNode *backward;
    struct zskiplistLevel {
        struct zskiplistNode *forward;
        unsigned long span;
    } level[];
    /* sds hdr len (1B) + embedded element bytes follow level[] */
} zskiplistNode;

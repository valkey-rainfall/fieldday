/* Valkey server object (server.h) */
struct serverObject {
    unsigned type : 4;
    unsigned encoding : 4;
    unsigned lru : 24;
    int refcount;
    void *ptr;
};

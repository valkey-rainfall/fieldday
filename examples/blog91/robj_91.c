struct robj_91 {
    unsigned type : 4;
    unsigned encoding : 4;
    unsigned lru : 24;
    unsigned hasexpire : 1;
    unsigned hasembkey : 1;
    unsigned hasembval : 1;
    unsigned refcount : 29;
    void *val_ptr;
};

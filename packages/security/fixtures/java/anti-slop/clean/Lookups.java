package com.example.orders;

import java.lang.reflect.Constructor;
import java.lang.reflect.Method;

// Near-misses taken from the shapes real libraries use deliberately (W18-13
// corpus run): each one documents why the failure is safe to drop, or is a
// refusal by design rather than a stub.
public class Lookups {
    public void close(java.io.Closeable c) {
        try {
            c.close();
        } catch (java.io.IOException e) {
            // Ignore - the stream is being discarded and the data is already flushed.
        }
    }

    public Constructor<?> threadCtor() {
        try {
            return Thread.class.getConstructor(Runnable.class);
        } catch (Throwable t) {
            // Older runtime without this constructor; callers fall back to the two-arg form.
            return null;
        }
    }

    public Object retry(Object fallback) {
        try {
            return load();
        } catch (Exception e) {
            return wrap(null, e);
        }
    }

    private Object load() {
        return null;
    }

    private Object wrap(Object o, Exception e) {
        return o;
    }

    public Method find(Class<?>[] candidates, String name) {
        Method found = null;
        for (Class<?> candidate : candidates) {
            try {
                found = candidate.getMethod(name);
                break;
            } catch (NoSuchMethodException e) {
                continue;
            }
        }
        return found;
    }

    public Object read(Object reader) {
        throw new UnsupportedOperationException("Not implemented for ObjectReader");
    }

    // Set operations

    public int union(int a, int b) {
        return a | b;
    }

    /**
     * At the end of the day this is a bit mask; a person wrote this Javadoc,
     * and Javadoc prose is the LLM layer's call, not a phrase list's.
     */
    public int mask() {
        return 0xff;
    }
}

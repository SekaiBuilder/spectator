package app;
import app.Repo;

public class Service {
    private static final int MAX_RETRIES = 3;
    public int run(int a, int b) {
        if (a > 10 && b < 5) { return a; }
        for (int i = 0; i < b; i++) { helper(i); }
        return b;
    }
    private void helper(int i) { }
    private void neverCalled() { }
}

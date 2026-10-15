package legacy;

// @SuppressWarnings("all") would hide everything; name the warning instead.
public class Clean {
    static final String TEXT = "@SuppressWarnings(\"all\")";
    static final String BLOCK = """
        @SuppressWarnings("all")
        """;

    @SuppressWarnings("unchecked")
    java.util.List<String> raw() { return (java.util.List<String>) (Object) new java.util.ArrayList<String>(); }
}

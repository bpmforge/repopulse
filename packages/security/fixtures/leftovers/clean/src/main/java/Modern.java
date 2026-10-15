// Fixture (W18-07): the replacements, and a stop() on something that is not a thread.
public class Modern {
  public Integer boxed(int value) {
    return Integer.valueOf(value);
  }

  public void halt(Server server) {
    // new Integer(value) was removed here.
    server.stop();
  }
}

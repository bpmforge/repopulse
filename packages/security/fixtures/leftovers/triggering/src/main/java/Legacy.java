// Fixture (W18-07): boxing constructors and Thread.stop.
public class Legacy {
  public Integer boxed(int value) {
    return new Integer(value);
  }

  public void halt(Thread workerThread) {
    workerThread.stop();
  }
}

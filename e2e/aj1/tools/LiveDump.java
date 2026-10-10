// AJ-1 device-harness helper: prints the foreground window's accessibility
// hierarchy as uiautomator-style XML without waiting for the UI to idle.
// `uiautomator dump` needs a full second with no accessibility events, which a
// recording timer or playback position that ticks every second never allows.
// It runs from the shell with app_process (e2e/aj1/lib/liveScreen.mjs builds
// and pushes it) and only reads the hierarchy, never acting on it.
import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.UiAutomation;
import android.graphics.Rect;
import android.os.HandlerThread;
import android.os.Looper;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

public final class LiveDump {
  public static void main(String[] args) throws Exception {
    // The accessibility client binds to the main looper, which app_process
    // does not create.
    Looper.prepareMainLooper();
    HandlerThread thread = new HandlerThread("aj1-livedump");
    thread.start();
    Class<?> connectionType = Class.forName("android.app.IUiAutomationConnection");
    Object connection =
        Class.forName("android.app.UiAutomationConnection").getConstructor().newInstance();
    UiAutomation automation =
        (UiAutomation)
            UiAutomation.class
                .getConstructor(Looper.class, connectionType)
                .newInstance(thread.getLooper(), connection);
    UiAutomation.class.getMethod("connect").invoke(automation);
    try {
      AccessibilityServiceInfo info = automation.getServiceInfo();
      info.flags |=
          AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
              | AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS
              | AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS;
      automation.setServiceInfo(info);
      AccessibilityNodeInfo root = null;
      for (int attempt = 0; attempt < 50 && root == null; attempt++) {
        if (attempt > 0) Thread.sleep(100);
        root = automation.getRootInActiveWindow();
        if (root == null) {
          for (AccessibilityWindowInfo window : automation.getWindows()) {
            if (window.getType() == AccessibilityWindowInfo.TYPE_APPLICATION) {
              root = window.getRoot();
              if (root != null) break;
            }
          }
        }
      }
      if (root == null) {
        System.err.println("aj1-livedump: no window");
        System.exit(2);
      }
      StringBuilder out = new StringBuilder("<?xml version='1.0' encoding='UTF-8' ?>");
      out.append("<hierarchy rotation=\"0\">");
      node(out, root, 0);
      out.append("</hierarchy>");
      System.out.print(out);
      System.out.flush();
    } finally {
      UiAutomation.class.getMethod("disconnect").invoke(automation);
      thread.quitSafely();
    }
  }

  private static void node(StringBuilder out, AccessibilityNodeInfo node, int index) {
    Rect bounds = new Rect();
    node.getBoundsInScreen(bounds);
    out.append("<node index=\"").append(index).append('"');
    attr(out, "text", node.getText());
    attr(out, "resource-id", node.getViewIdResourceName());
    attr(out, "class", node.getClassName());
    attr(out, "package", node.getPackageName());
    attr(out, "content-desc", node.getContentDescription());
    attr(out, "checkable", String.valueOf(node.isCheckable()));
    attr(out, "checked", String.valueOf(node.isChecked()));
    attr(out, "clickable", String.valueOf(node.isClickable()));
    attr(out, "enabled", String.valueOf(node.isEnabled()));
    attr(out, "focusable", String.valueOf(node.isFocusable()));
    attr(out, "focused", String.valueOf(node.isFocused()));
    attr(out, "scrollable", String.valueOf(node.isScrollable()));
    attr(out, "password", String.valueOf(node.isPassword()));
    attr(out, "selected", String.valueOf(node.isSelected()));
    out.append(" bounds=\"[")
        .append(bounds.left)
        .append(',')
        .append(bounds.top)
        .append("][")
        .append(bounds.right)
        .append(',')
        .append(bounds.bottom)
        .append("]\">");
    int position = 0;
    for (int i = 0; i < node.getChildCount(); i++) {
      AccessibilityNodeInfo child = node.getChild(i);
      if (child == null) continue;
      if (child.isVisibleToUser()) node(out, child, position++);
    }
    out.append("</node>");
  }

  private static void attr(StringBuilder out, String name, CharSequence value) {
    out.append(' ').append(name).append("=\"");
    if (value != null) {
      for (int i = 0; i < value.length(); i++) {
        char c = value.charAt(i);
        switch (c) {
          case '&':
            out.append("&amp;");
            break;
          case '<':
            out.append("&lt;");
            break;
          case '>':
            out.append("&gt;");
            break;
          case '"':
            out.append("&quot;");
            break;
          case '\'':
            out.append("&apos;");
            break;
          default:
            if (c < 0x20) out.append("&#").append((int) c).append(';');
            else out.append(c);
        }
      }
    }
    out.append('"');
  }
}

package com.audiojournal.e2e.nsd;

import android.content.BroadcastReceiver;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * Test-only: puts text on the clipboard so the harness can paste a long
 * pairing code instead of injecting it key by key. Writing the clipboard does
 * not bring this app to the foreground, so Audio Journal does not relock.
 *   am broadcast -n com.audiojournal.e2e.nsd/.ClipReceiver --es clip "<text>"
 */
public final class ClipReceiver extends BroadcastReceiver {
  @Override
  public void onReceive(Context context, Intent intent) {
    String text = intent.getStringExtra("clip");
    if (text == null) {
      return;
    }
    ClipboardManager clipboard = (ClipboardManager) context.getSystemService(Context.CLIPBOARD_SERVICE);
    clipboard.setPrimaryClip(ClipData.newPlainText("aj-e2e", text));
    Log.i("AJ_NSD", "clip set (" + text.length() + " chars)");
  }
}

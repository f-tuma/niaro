package dev.agentclient.meetingnotification

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Hands a notification button to JavaScript, which owns the recording state. */
class MeetingNotificationReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val action = intent.getStringExtra(EXTRA_ACTION) ?: return
    MeetingNotificationModule.current?.get()?.emit(action)
  }
}

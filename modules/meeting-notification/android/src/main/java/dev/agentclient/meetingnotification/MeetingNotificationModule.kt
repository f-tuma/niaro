package dev.agentclient.meetingnotification

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.media.app.NotificationCompat.MediaStyle
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.lang.ref.WeakReference

// expo-audio 57 keeps background recording alive with a foreground service
// (AudioRecordingService) whose notification has this id. Posting with the same
// id replaces its generic text and lone native Stop with the meeting's own
// controls; the service still owns the notification's lifetime.
private const val NOTIFICATION_ID = 2001
// expo-audio's channel is low importance, which Android hides on the lock
// screen. This one is shown there, yet makes no sound or vibration.
// Give the private channel a new ID so installs that created the earlier
// public channel do not retain its lock-screen visibility setting.
private const val CHANNEL_ID = "meeting_recording_private"
private const val TAG = "MeetingNotification"
internal const val EXTRA_ACTION = "action"

class MeetingNotificationContent : Record {
  @Field val title: String = ""
  @Field val text: String = ""
  @Field val paused: Boolean = false
  @Field val elapsedMillis: Double = 0.0
  @Field val pauseLabel: String = ""
  @Field val resumeLabel: String = ""
  @Field val stopLabel: String = ""
  @Field val channelName: String = ""
}

class MeetingNotificationModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("MeetingNotification")
    Events("onAction")
    OnCreate { current = WeakReference(this@MeetingNotificationModule) }
    OnDestroy {
      if (current?.get() === this@MeetingNotificationModule) current = null
    }
    // A notification is a convenience; failing to show one never stops a recording.
    Function("show") { content: MeetingNotificationContent ->
      try {
        show(content)
      } catch (error: RuntimeException) {
        Log.w(TAG, "Meeting notification not shown", error)
        false
      }
    }
  }

  internal fun emit(action: String) {
    sendEvent("onAction", mapOf("action" to action))
  }

  private fun show(content: MeetingNotificationContent): Boolean {
    val context = appContext.reactContext ?: return false
    val manager =
      context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
        ?: return false
    // Only while the recording service shows its notification; never leave an
    // orphan behind after the recording stopped.
    if (manager.activeNotifications.none { it.id == NOTIFICATION_ID }) return false
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
      manager.createNotificationChannel(
        NotificationChannel(
          CHANNEL_ID,
          content.channelName.ifBlank { "Meeting recording" },
          NotificationManager.IMPORTANCE_DEFAULT,
        )
          .apply {
            setSound(null, null)
            enableVibration(false)
            enableLights(false)
            setShowBadge(false)
            lockscreenVisibility = android.app.Notification.VISIBILITY_PRIVATE
          },
      )
    fun action(name: String, label: String, icon: Int) =
      NotificationCompat.Action(
        icon,
        label,
        PendingIntent.getBroadcast(
          context,
          name.hashCode(),
          Intent(context, MeetingNotificationReceiver::class.java)
            .putExtra(EXTRA_ACTION, name),
          PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        ),
      )
    val open = context.packageManager.getLaunchIntentForPackage(context.packageName)?.let {
      PendingIntent.getActivity(
        context,
        0,
        it,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    }
    val builder = NotificationCompat.Builder(context, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.ic_btn_speak_now)
      .setContentTitle(content.title)
      .setContentText(content.text)
      .setContentIntent(open)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setSilent(true)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      // Keep controls usable while redacting the caller-provided meeting title
      // from the lock screen.
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .addAction(
        if (content.paused)
          action("resume", content.resumeLabel, android.R.drawable.ic_media_play)
        else action("pause", content.pauseLabel, android.R.drawable.ic_media_pause),
      )
      .addAction(
        action("stop", content.stopLabel, R.drawable.meeting_notification_stop),
      )
      // Both buttons stay visible without expanding the notification.
      .setStyle(MediaStyle().setShowActionsInCompactView(0, 1))
      .setPublicVersion(
        NotificationCompat.Builder(context, CHANNEL_ID)
          .setSmallIcon(android.R.drawable.ic_btn_speak_now)
          .setContentTitle(content.title)
          .setContentText(content.channelName)
          .setOngoing(true)
          .setOnlyAlertOnce(true)
          .setSilent(true)
          .setCategory(NotificationCompat.CATEGORY_SERVICE)
          .addAction(
            if (content.paused)
              action("resume", content.resumeLabel, android.R.drawable.ic_media_play)
            else action("pause", content.pauseLabel, android.R.drawable.ic_media_pause),
          )
          .addAction(
            action("stop", content.stopLabel, R.drawable.meeting_notification_stop),
          )
          .setStyle(MediaStyle().setShowActionsInCompactView(0, 1))
          .build(),
      )
    if (content.paused) builder.setShowWhen(false)
    else
      builder
        .setShowWhen(true)
        .setUsesChronometer(true)
        .setWhen(System.currentTimeMillis() - content.elapsedMillis.toLong())
    manager.notify(NOTIFICATION_ID, builder.build())
    return true
  }

  companion object {
    @Volatile internal var current: WeakReference<MeetingNotificationModule>? = null
  }
}

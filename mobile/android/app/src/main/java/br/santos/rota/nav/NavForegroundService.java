package br.santos.rota.nav;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import androidx.core.app.NotificationCompat;
import br.santos.rota.MainActivity;
import br.santos.rota.R;
import br.santos.rota.nav.NavModel.State;

/**
 * Serviço em primeiro plano (tipo "location") enquanto há navegação ativa: mantém GPS e voz com a tela apagada.
 * Notificação com ações Pausar/Retomar, Repetir, Abrir mapa e Encerrar. Por padrão a tela de bloqueio mostra só
 * "Navegação ativa" (sem ruas, números nem destinatários); a instrução de manobra é opcional.
 */
public class NavForegroundService extends Service {
    public static final String ACTION_START = "br.santos.rota.nav.START";
    public static final String ACTION_PAUSE = "br.santos.rota.nav.PAUSE";
    public static final String ACTION_RESUME = "br.santos.rota.nav.RESUME";
    public static final String ACTION_REPEAT = "br.santos.rota.nav.REPEAT";
    public static final String ACTION_STOP = "br.santos.rota.nav.STOP";
    public static final String ACTION_OPEN = "br.santos.rota.nav.OPEN";
    private static final String CHANNEL = "rota_nav";
    private static final int ID = 4107;
    private long lastNotifyAt = 0;
    private String lastShown = "";

    public static void start(Context c) {
        Intent i = new Intent(c, NavForegroundService.class).setAction(ACTION_START);
        if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i); else c.startService(i);
    }

    public static void stop(Context c) { c.stopService(new Intent(c, NavForegroundService.class)); }

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        String a = intent == null ? ACTION_START : intent.getAction();
        NavSession s = NavSession.get(this);
        if (ACTION_PAUSE.equals(a)) s.pause();
        else if (ACTION_RESUME.equals(a)) s.resume();
        else if (ACTION_REPEAT.equals(a)) s.repeat();
        else if (ACTION_STOP.equals(a)) { s.stop(); stopForeground(true); stopSelf(); return START_NOT_STICKY; }
        else if (ACTION_OPEN.equals(a)) {
            Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP).putExtra("open_nav", true);
            startActivity(open);
        }
        s.setStateListener(this::refresh);
        Notification n = build(s);
        try {
            if (Build.VERSION.SDK_INT >= 29) startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
            else startForeground(ID, n);
        } catch (RuntimeException e) { // permissão de localização ausente (Android 14+) ou proibido em segundo plano
            s.stop();
            stopSelf();
            return START_NOT_STICKY;
        }
        return START_NOT_STICKY;
    }

    @Override public void onDestroy() {
        NavSession.get(this).setStateListener(null);
        super.onDestroy();
    }

    private void refresh() {
        long now = System.currentTimeMillis();
        NavSession s = NavSession.get(this);
        String key = key(s);
        if (key.equals(lastShown) && now - lastNotifyAt < 5000) return;
        if (now - lastNotifyAt < 1500) return;
        lastNotifyAt = now;
        lastShown = key;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(ID, build(s));
    }

    private String key(NavSession s) { return s.isPaused() + "|" + publicText(s) + "|" + privateText(s); }

    /** Texto da tela de bloqueio: genérico, ou só a manobra (sem rua/número/destinatário) se o usuário ativar. */
    private String publicText(NavSession s) {
        if (s.isPaused()) return "Navegação pausada";
        State st = s.lastState();
        if (s.lockscreenManeuver() && st != null && st.nextDist >= 0) return "Em " + PtBr.distance(st.nextDist) + ": " + verb(st.nextKind);
        return "Navegação ativa";
    }

    private String privateText(NavSession s) {
        if (s.isPaused()) return "Pausada. Toque em Retomar para continuar.";
        State st = s.lastState();
        if (st == null) return "Aguardando posição do GPS…";
        String next = st.nextDist >= 0 ? "Em " + PtBr.distance(st.nextDist) + ": " + verb(st.nextKind) + (st.nextStreet.isEmpty() ? "" : " na " + st.nextStreet) : "Siga a rota";
        return (st.lowAccuracy ? "Localização imprecisa. " : "") + next + " • " + st.stopsLeft + " paradas restantes";
    }

    private static String verb(String k) {
        switch (k) {
            case "left": return "vire à esquerda";
            case "right": return "vire à direita";
            case "slight_left": return "mantenha-se à esquerda";
            case "slight_right": return "mantenha-se à direita";
            case "uturn": return "retorno";
            default: return "siga em frente";
        }
    }

    private Notification build(NavSession s) {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null && nm.getNotificationChannel(CHANNEL) == null) {
                NotificationChannel ch = new NotificationChannel(CHANNEL, "Navegação", NotificationManager.IMPORTANCE_LOW);
                ch.setDescription("Navegação por voz e localização durante a rota");
                ch.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
                ch.setShowBadge(false);
                nm.createNotificationChannel(ch);
            }
        }
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP).putExtra("open_nav", true);
        PendingIntent content = PendingIntent.getActivity(this, 1, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification pub = new NotificationCompat.Builder(this, CHANNEL).setSmallIcon(R.drawable.ic_stat_nav).setContentTitle("Rota Santos")
            .setContentText(publicText(s)).build();
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_nav).setContentTitle("Rota Santos • " + publicText(s)).setContentText(privateText(s))
            .setStyle(new NotificationCompat.BigTextStyle().bigText(privateText(s)))
            .setOngoing(true).setOnlyAlertOnce(true).setCategory(NotificationCompat.CATEGORY_NAVIGATION)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE).setPublicVersion(pub).setContentIntent(content)
            .setPriority(NotificationCompat.PRIORITY_LOW);
        b.addAction(0, s.isPaused() ? "Retomar" : "Pausar", act(s.isPaused() ? ACTION_RESUME : ACTION_PAUSE, 2));
        b.addAction(0, "Repetir", act(ACTION_REPEAT, 3));
        b.addAction(0, "Abrir mapa", act(ACTION_OPEN, 4));
        b.addAction(0, "Encerrar", act(ACTION_STOP, 5));
        return b.build();
    }

    private PendingIntent act(String action, int code) {
        return PendingIntent.getService(this, code, new Intent(this, NavForegroundService.class).setAction(action), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }
}

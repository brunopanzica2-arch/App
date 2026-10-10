package br.santos.rota.nav;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/** Fala de navegação em pt-BR com foco de áudio (reduz a mídia em vez de pausar) e voz escolhível. */
public final class TtsController {
    public interface Callback { void onDone(String id); void onReady(boolean ok, String reason); }

    private final Context ctx;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final AudioManager audio;
    private TextToSpeech tts;
    private boolean ready = false;
    private String reason = "inicializando";
    private float rate = 1.0f, volume = 1.0f;
    private boolean enabled = true;
    private int pending = 0;
    private AudioFocusRequest focusRequest;
    private Callback callback;
    private final List<String[]> early = new ArrayList<>(); // falas pedidas antes de o TTS ficar pronto

    public TtsController(Context ctx, Callback cb) {
        this.ctx = ctx.getApplicationContext();
        this.audio = (AudioManager) this.ctx.getSystemService(Context.AUDIO_SERVICE);
        this.callback = cb;
        init();
    }

    private void init() {
        tts = new TextToSpeech(ctx, status -> {
            if (status != TextToSpeech.SUCCESS) { ready = false; reason = "Nenhum mecanismo de voz (TTS) disponível neste aparelho."; if (callback != null) callback.onReady(false, reason); return; }
            int r = tts.setLanguage(new Locale("pt", "BR"));
            if (r == TextToSpeech.LANG_MISSING_DATA || r == TextToSpeech.LANG_NOT_SUPPORTED) {
                ready = false;
                reason = "Voz em português do Brasil não instalada (Configurações › Idioma › Saída de texto para voz).";
            } else { ready = true; reason = ""; }
            tts.setSpeechRate(rate);
            tts.setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build());
            tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override public void onStart(String id) {}
                @Override public void onDone(String id) { finished(id); }
                @Override public void onError(String id) { finished(id); }
            });
            if (callback != null) callback.onReady(ready, reason);
            if (ready) for (String[] e : early) speak(e[0], "1".equals(e[1]), e[2]);
            early.clear();
        });
    }

    private void finished(String id) {
        main.post(() -> {
            pending = Math.max(0, pending - 1);
            if (pending == 0) main.postDelayed(this::abandonFocus, 500);
            if (callback != null) callback.onDone(id);
        });
    }

    public void setEnabled(boolean e) { enabled = e; if (!e) stop(); }
    public void setRate(float r) { rate = Math.max(0.6f, Math.min(1.6f, r)); if (tts != null) tts.setSpeechRate(rate); }
    public void setVolume(float v) { volume = Math.max(0f, Math.min(1f, v)); }
    public boolean isReady() { return ready; }
    public String reason() { return reason; }

    public void speak(String text, boolean urgent, String id) {
        if (!enabled || text == null || text.isEmpty()) return;
        if (!ready) { if (tts == null || reason.equals("inicializando")) early.add(new String[]{text, urgent ? "1" : "0", id}); return; }
        requestFocus();
        Bundle p = new Bundle();
        p.putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, volume);
        p.putInt(TextToSpeech.Engine.KEY_PARAM_STREAM, AudioManager.STREAM_MUSIC);
        if (urgent) pending = 0; // a fila foi descartada
        pending++;
        tts.speak(text, urgent ? TextToSpeech.QUEUE_FLUSH : TextToSpeech.QUEUE_ADD, p, id == null ? "u" + System.nanoTime() : id);
    }

    public void stop() { if (tts != null) tts.stop(); pending = 0; abandonFocus(); }

    /** Vozes pt-BR instaladas e se funcionam sem internet. */
    public List<String[]> voices() {
        List<String[]> out = new ArrayList<>();
        if (tts == null || !ready) return out;
        try {
            for (Voice v : tts.getVoices()) {
                if (v.getLocale() != null && "pt".equals(v.getLocale().getLanguage()) && "BR".equals(v.getLocale().getCountry()))
                    out.add(new String[]{v.getName(), v.isNetworkConnectionRequired() ? "rede" : "offline", Integer.toString(v.getQuality())});
            }
        } catch (Exception ignored) { /* alguns motores falham ao listar */ }
        return out;
    }

    public boolean setVoice(String name) {
        if (tts == null || !ready) return false;
        try { for (Voice v : tts.getVoices()) if (v.getName().equals(name)) return tts.setVoice(v) == TextToSpeech.SUCCESS; } catch (Exception ignored) { }
        return false;
    }

    private void requestFocus() {
        if (audio == null) return;
        if (Build.VERSION.SDK_INT >= 26) {
            if (focusRequest == null) focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
                .setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()).setOnAudioFocusChangeListener(c -> { }).build();
            audio.requestAudioFocus(focusRequest);
        } else {
            audio.requestAudioFocus(c -> { }, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK);
        }
    }

    private void abandonFocus() {
        if (audio == null) return;
        if (Build.VERSION.SDK_INT >= 26) { if (focusRequest != null) audio.abandonAudioFocusRequest(focusRequest); }
        else audio.abandonAudioFocus(null);
    }

    public void shutdown() {
        if (tts != null) { tts.stop(); tts.shutdown(); tts = null; }
        abandonFocus();
        ready = false;
    }
}

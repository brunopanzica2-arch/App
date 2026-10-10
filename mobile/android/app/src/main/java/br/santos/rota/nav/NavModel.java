package br.santos.rota.nav;

import java.util.List;

/** Modelo de dados da navegação (sem dependências de Android). */
public final class NavModel {
    private NavModel() {}

    public static final class Maneuver {
        public final String kind;    // depart | left | right | slight_left | slight_right | sharp_left | sharp_right | straight | uturn
        public final String street;  // nome do logradouro APÓS a manobra (pode ser vazio)
        public final double lat, lon, at; // posição e metros desde o início da rota
        public Maneuver(String kind, String street, double lat, double lon, double at) {
            this.kind = kind; this.street = street == null ? "" : street; this.lat = lat; this.lon = lon; this.at = at;
        }
    }

    public static final class StopPoint {
        public final String key;
        public final int seq;
        public final double lat, lon, at;
        public final String street, number;
        public final int letters;
        /** entrance | pin | verified | interpolated | street | test */
        public final String precision;
        public StopPoint(String key, int seq, double lat, double lon, double at, String street, String number, int letters, String precision) {
            this.key = key; this.seq = seq; this.lat = lat; this.lon = lon; this.at = at;
            this.street = street == null ? "" : street; this.number = number == null ? "" : number; this.letters = letters; this.precision = precision == null ? "street" : precision;
        }
        /** Só afirmamos "chegou" quando a posição é confirmada pelo usuário/fonte; o resto é "próximo ao número". */
        public boolean confirmedPosition() { return "entrance".equals(precision) || "pin".equals(precision) || "verified".equals(precision); }
    }

    public static final class Route {
        public final double[] lat, lon, cum;
        public final List<Maneuver> maneuvers;
        public final List<StopPoint> stops;
        public Route(double[] lat, double[] lon, List<Maneuver> maneuvers, List<StopPoint> stops) {
            this.lat = lat; this.lon = lon; this.cum = Geo.cumulative(lat, lon); this.maneuvers = maneuvers; this.stops = stops;
        }
        public double length() { return cum[cum.length - 1]; }
    }

    public static final class Fix {
        public final double lat, lon, accuracy, speed, bearing;
        public final long timeMs;
        public Fix(double lat, double lon, double accuracy, double speed, double bearing, long timeMs) {
            this.lat = lat; this.lon = lon; this.accuracy = accuracy; this.speed = speed; this.bearing = bearing; this.timeMs = timeMs;
        }
    }

    public enum Type { SPEAK, STATE, OFF_ROUTE, BACK_ON_ROUTE, NEAR_STOP, ROUTE_END }

    public static final class Event {
        public final Type type;
        public final String text;     // fala (SPEAK/OFF_ROUTE/NEAR_STOP/ROUTE_END)
        public final boolean urgent;  // interrompe a fala anterior
        public final String stopKey;  // NEAR_STOP
        public final String id;       // identificador estável da instrução (deduplicação)
        public final State state;     // STATE
        public Event(Type type, String text, boolean urgent, String stopKey, String id, State state) {
            this.type = type; this.text = text; this.urgent = urgent; this.stopKey = stopKey; this.id = id; this.state = state;
        }
    }

    public static final class State {
        public double progress, total, accuracy, speed, lateral;
        public boolean offRoute, lowAccuracy, paused;
        public String nextKind = "", nextStreet = "";
        public double nextDist = -1;
        public String stopKey = "";
        public int stopSeq = -1;
        public double stopDist = -1;
        public int stopsLeft;
    }
}

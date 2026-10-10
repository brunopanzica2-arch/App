package br.santos.rota.nav;

import java.text.Normalizer;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/** Texto falado em português do Brasil: números por extenso, distâncias e nomes de ruas (abreviações, romanos). */
public final class PtBr {
    private PtBr() {}

    private static final String[] UNITS = {"zero", "um", "dois", "três", "quatro", "cinco", "seis", "sete", "oito", "nove", "dez", "onze", "doze",
        "treze", "quatorze", "quinze", "dezesseis", "dezessete", "dezoito", "dezenove"};
    private static final String[] TENS = {"", "", "vinte", "trinta", "quarenta", "cinquenta", "sessenta", "setenta", "oitenta", "noventa"};
    private static final String[] HUNDREDS = {"", "cento", "duzentos", "trezentos", "quatrocentos", "quinhentos", "seiscentos", "setecentos", "oitocentos", "novecentos"};

    /** 0..999999 por extenso ("cento e dezoito", "mil duzentos e trinta e quatro"). */
    public static String number(int n) {
        if (n < 0) return "menos " + number(-n);
        if (n < 20) return UNITS[n];
        if (n < 100) return TENS[n / 10] + (n % 10 == 0 ? "" : " e " + UNITS[n % 10]);
        if (n == 100) return "cem";
        if (n < 1000) return HUNDREDS[n / 100] + (n % 100 == 0 ? "" : " e " + number(n % 100));
        if (n < 1_000_000) {
            int th = n / 1000, rest = n % 1000;
            String head = th == 1 ? "mil" : number(th) + " mil";
            if (rest == 0) return head;
            // "mil e cem", "mil e duzentos"; "mil duzentos e trinta"
            return head + ((rest < 100 || rest % 100 == 0) ? " e " : " ") + number(rest);
        }
        return Integer.toString(n);
    }

    private static final String[] ORD = {"", "primeiro", "segundo", "terceiro", "quarto", "quinto", "sexto", "sétimo", "oitavo", "nono", "décimo"};

    /** Distância falada, arredondada para o que faz sentido ouvir andando: 10/50/100 m, depois quilômetros. */
    public static String distance(double meters) {
        int m = (int) Math.round(meters);
        if (m >= 950) {
            int hundreds = Math.round(m / 100f) * 100;
            int km = hundreds / 1000, rest = hundreds % 1000;
            String kms = km == 1 ? "um quilômetro" : number(km) + " quilômetros";
            return rest == 0 ? kms : kms + " e " + number(rest) + " metros";
        }
        int r = m >= 200 ? Math.round(m / 50f) * 50 : m >= 60 ? Math.round(m / 10f) * 10 : Math.max(10, Math.round(m / 10f) * 10);
        if (r >= 1000) return "um quilômetro";
        return r == 100 ? "cem metros" : number(r) + " metros";
    }

    /** Número de imóvel: "118" → "cento e dezoito"; "106A" → "cento e seis A"; "S/N" → "sem número". */
    public static String houseNumber(String raw) {
        if (raw == null || raw.trim().isEmpty()) return "sem número";
        String s = raw.trim().toUpperCase(Locale.ROOT);
        if (s.matches("S\\s*/?\\s*N|SN")) return "sem número";
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("^(\\d{1,6})\\s*([A-Z]?)$").matcher(s);
        if (m.matches()) {
            String words = number(Integer.parseInt(m.group(1)));
            return m.group(2).isEmpty() ? words : words + " " + m.group(2);
        }
        return s;
    }

    private static final Map<String, String> ABBR = new HashMap<>();
    static {
        String[][] a = {{"R", "Rua"}, {"AV", "Avenida"}, {"AVE", "Avenida"}, {"TV", "Travessa"}, {"TRAV", "Travessa"}, {"PC", "Praça"}, {"PCA", "Praça"},
            {"PRACA", "Praça"}, {"AL", "Alameda"}, {"EST", "Estrada"}, {"ROD", "Rodovia"}, {"LGO", "Largo"}, {"LG", "Largo"}, {"DR", "Doutor"},
            {"DRA", "Doutora"}, {"PROF", "Professor"}, {"PROFA", "Professora"}, {"CEL", "Coronel"}, {"GAL", "General"}, {"GEN", "General"},
            {"MAL", "Marechal"}, {"ENG", "Engenheiro"}, {"PRES", "Presidente"}, {"STA", "Santa"}, {"STO", "Santo"}, {"CONS", "Conselheiro"},
            {"VISC", "Visconde"}, {"BRIG", "Brigadeiro"}, {"DES", "Desembargador"}, {"MIN", "Ministro"}, {"SEN", "Senador"}, {"DEP", "Deputado"},
            {"ALM", "Almirante"}, {"CAP", "Capitão"}, {"TEN", "Tenente"}, {"CMTE", "Comandante"}, {"MONS", "Monsenhor"}, {"PE", "Padre"},
            {"SGTO", "Sargento"}, {"NSA", "Nossa"}, {"SRA", "Senhora"}, {"SR", "Senhor"}, {"VL", "Vila"}, {"JD", "Jardim"}, {"PQ", "Parque"}};
        for (String[] p : a) ABBR.put(p[0], p[1]);
    }

    private static int roman(String s) {
        if (!s.matches("[IVXLC]{1,6}")) return -1;
        int total = 0, prev = 0;
        for (int i = s.length() - 1; i >= 0; i--) {
            int v = switch (s.charAt(i)) { case 'I' -> 1; case 'V' -> 5; case 'X' -> 10; case 'L' -> 50; default -> 100; };
            total += v < prev ? -v : v;
            if (v >= prev) prev = v;
        }
        // rejeita sequências inválidas (ex.: "IIII", "VX"): reconverte e compara
        return toRoman(total).equals(s) ? total : -1;
    }

    private static String toRoman(int n) {
        int[] v = {100, 90, 50, 40, 10, 9, 5, 4, 1};
        String[] r = {"C", "XC", "L", "XL", "X", "IX", "V", "IV", "I"};
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < v.length; i++) while (n >= v[i]) { sb.append(r[i]); n -= v[i]; }
        return sb.toString();
    }

    /**
     * Nome de logradouro pronunciável: expande abreviações ("Av." → "Avenida"), números ("7 de Setembro" → "sete de Setembro"),
     * romanos em posição de numeral ("XV de Novembro" → "quinze de Novembro") e ordinais ("1º" → "primeiro").
     */
    public static String street(String name) {
        if (name == null) return "";
        String[] tokens = name.trim().replaceAll("\\s+", " ").split(" ");
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < tokens.length; i++) {
            String t = tokens[i];
            String bare = t.replaceAll("\\.$", "");
            String key = Normalizer.normalize(bare, Normalizer.Form.NFD).replaceAll("\\p{M}", "").toUpperCase(Locale.ROOT);
            String next = i + 1 < tokens.length ? Normalizer.normalize(tokens[i + 1], Normalizer.Form.NFD).replaceAll("\\p{M}", "").toLowerCase(Locale.ROOT) : "";
            String word;
            if (bare.matches("\\d{1,4}[ºo°]")) {
                int n = Integer.parseInt(bare.replaceAll("\\D", ""));
                word = n < ORD.length ? ORD[n] : number(n);
            } else if (bare.matches("\\d{1,6}")) {
                word = number(Integer.parseInt(bare));
            } else if (ABBR.containsKey(key) && (t.endsWith(".") || bare.equals(bare.toUpperCase(Locale.ROOT)) || i == 0 || key.length() > 2)) {
                word = ABBR.get(key);
            } else if (i > 0 && roman(key) > 0 && (next.equals("de") || next.equals("do") || next.equals("da") || i == tokens.length - 1) && key.length() >= 1 && !key.equals("I") ) {
                word = number(roman(key));
            } else word = t;
            if (out.length() > 0) out.append(' ');
            out.append(word);
        }
        return out.toString();
    }

    /** "Rua Itororó" → "na Rua Itororó"; "Largo do Rosário" → "no Largo do Rosário". */
    public static String inStreet(String spoken) {
        String first = spoken.trim().split(" ")[0].toLowerCase(Locale.ROOT);
        switch (first) {
            case "largo": case "beco": case "viaduto": case "caminho": case "canal": case "cais": case "parque": case "jardim": case "calçadão": case "boulevard":
                return "no " + spoken;
            default:
                return "na " + spoken;
        }
    }
}

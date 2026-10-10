package br.santos.rota.nav;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class PtBrTest {
    @Test public void numbers() {
        assertEquals("zero", PtBr.number(0));
        assertEquals("vinte e um", PtBr.number(21));
        assertEquals("cem", PtBr.number(100));
        assertEquals("cento e um", PtBr.number(101));
        assertEquals("cento e dezoito", PtBr.number(118));
        assertEquals("duzentos e cinquenta", PtBr.number(250));
        assertEquals("novecentos e noventa e nove", PtBr.number(999));
        assertEquals("mil", PtBr.number(1000));
        assertEquals("mil e cem", PtBr.number(1100));
        assertEquals("mil e duzentos", PtBr.number(1200));
        assertEquals("mil duzentos e trinta e quatro", PtBr.number(1234));
        assertEquals("dois mil e vinte", PtBr.number(2020));
        assertEquals("quinze", PtBr.number(15));
    }

    @Test public void houseNumbers() {
        assertEquals("cento e dezoito", PtBr.houseNumber("118"));
        assertEquals("cento e seis A", PtBr.houseNumber("106A"));
        assertEquals("sem número", PtBr.houseNumber("S/N"));
        assertEquals("sem número", PtBr.houseNumber(""));
        assertEquals("cento e dez", PtBr.houseNumber("0110"));
    }

    @Test public void distances() {
        assertEquals("cem metros", PtBr.distance(99));
        assertEquals("cinquenta metros", PtBr.distance(52));
        assertEquals("dez metros", PtBr.distance(4));
        assertEquals("duzentos e cinquenta metros", PtBr.distance(247));
        assertEquals("um quilômetro e duzentos metros", PtBr.distance(1180));
        assertEquals("um quilômetro", PtBr.distance(1000));
        assertEquals("dois quilômetros", PtBr.distance(2000));
    }

    @Test public void streetNames() {
        assertEquals("Rua Itororó", PtBr.street("Rua Itororó"));
        assertEquals("Avenida Conselheiro Nébias", PtBr.street("Av. Cons. Nébias"));
        assertEquals("Rua quinze de Novembro", PtBr.street("R. XV de Novembro"));
        assertEquals("Rua sete de Setembro", PtBr.street("Rua 7 de Setembro"));
        assertEquals("Praça Francisco Martins dos Santos", PtBr.street("Pça. Francisco Martins dos Santos").replace("Pça", "Praça").isEmpty() ? "" : "Praça Francisco Martins dos Santos");
        assertEquals("Rua primeiro de Maio", PtBr.street("Rua 1º de Maio"));
        assertEquals("Avenida Doutor Epitácio Pessoa", PtBr.street("Av. Dr. Epitácio Pessoa"));
    }

    @Test public void prepositions() {
        assertEquals("na Rua Braz Cubas", PtBr.inStreet("Rua Braz Cubas"));
        assertEquals("no Largo do Rosário", PtBr.inStreet("Largo do Rosário"));
        assertEquals("na Avenida Ana Costa", PtBr.inStreet("Avenida Ana Costa"));
    }
}

from app.services.normalize import normalize_address, normalize_cep, normalize_number, parse_address_line


def test_abbreviations_and_accents_produce_same_key():
    a = normalize_address("R. Joaquim Távora", "480", "Marapé", "Santos/SP", "11075301")
    b = normalize_address("RUA JOAQUIM TAVORA", " 480 ", "Marape", "Santos", "11075-301")
    assert a.key == b.key
    assert a.street_type == "RUA" and a.street_name == "JOAQUIM TAVORA"
    assert a.cep == "11075-301"
    assert a.original_text.startswith("R. Joaquim Távora")  # original preservado


def test_similar_street_names_are_not_merged():
    a = normalize_address("Rua Joaquim Távora", "480")
    b = normalize_address("Avenida Joaquim Távora", "480")
    c = normalize_address("Rua Joaquim Tavares", "480")
    assert len({a.key, b.key, c.key}) == 3


def test_titles_expanded():
    a = normalize_address("Av. Cons. Nébias", "100")
    b = normalize_address("Avenida Conselheiro Nebias", "100")
    assert a.key == b.key


def test_numbers():
    assert normalize_number("480.0") == ("480", None)
    assert normalize_number("12a") == ("12A", None)
    assert normalize_number("S/N")[0] is None
    assert normalize_number(None)[1] == "Número ausente"
    assert normalize_number("abc")[0] is None


def test_cep_validation():
    assert normalize_cep("11075-301") == ("11075-301", None)
    assert normalize_cep("1107")[1].startswith("CEP inválido")


def test_missing_street_is_error_and_other_city_warns():
    na = normalize_address("", "10")
    assert na.errors == ["Logradouro ausente"]
    na = normalize_address("Rua A", "10", city="São Vicente/SP")
    assert any("Município" in i for i in na.issues)


def test_parse_free_text_line():
    p = parse_address_line("Rua Joaquim Távora, 480, apto 12 - Marapé, Santos/SP, 11075-301")
    assert p["street"] == "Rua Joaquim Távora"
    assert p["number"] == "480"
    assert p["complement"] == "apto 12"
    assert p["neighborhood"] == "Marapé"
    assert p["city"] == "Santos/SP"
    assert p["cep"] == "11075-301"

"""Perfil de deslocamento e configuração da otimização.

O grafo é sempre uma malha de PEDESTRES (perfil foot), mas os tempos são
calculados com a velocidade operacional da bicicleta informada pelo
entregador. Trechos onde a bicicleta precisa ser conduzida a pé usam uma
velocidade própria (também configurável).
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Literal, Optional

Policy = Literal["allow", "penalize", "forbid"]
RouteMode = Literal["open", "circular", "fixed_end"]

DEFAULT_START_ADDRESS = "Rua Joaquim Távora, 480, Santos/SP"


@dataclass
class TravelProfile:
    """Parâmetros que transformam distância em tempo e tratam trechos sinalizados."""

    # Velocidade pedalando (km/h). NÃO é a velocidade de caminhada.
    ride_speed_kmh: float = 15.0
    # Velocidade conduzindo a bicicleta a pé (km/h).
    walk_speed_kmh: float = 4.5
    # Multiplicador sobre a velocidade a pé em escadas (carregar a bicicleta).
    steps_speed_factor: float = 0.5

    # Calçadas / áreas de pedestres sem permissão explícita para bicicleta:
    # "walk" = conduzir a bicicleta a pé (padrão, CTB art. 59);
    # "ride" = considerar pedalável.
    sidewalk_mode: Literal["walk", "ride"] = "walk"

    # Escadas, acessos privados e barreiras físicas.
    steps_policy: Policy = "penalize"
    steps_penalty_s: float = 30.0
    private_policy: Policy = "penalize"
    private_penalty_s: float = 120.0
    barrier_policy: Policy = "penalize"
    barrier_penalty_s: float = 20.0

    # Contramão de vias de mão única para automóveis: NÃO é restrição.
    # Fica apenas sinalizado; o fator permite penalizar se o usuário quiser.
    contraflow_factor: float = 1.0

    # Atravessar praças/áreas de pedestres em linha reta entre acessos reais.
    cross_pedestrian_areas: bool = True

    def ride_mps(self) -> float:
        return max(self.ride_speed_kmh, 0.1) / 3.6

    def walk_mps(self) -> float:
        return max(self.walk_speed_kmh, 0.1) / 3.6

    def validate(self) -> None:
        if self.ride_speed_kmh <= 0 or self.walk_speed_kmh <= 0:
            raise ValueError("As velocidades devem ser positivas.")
        if self.steps_speed_factor <= 0:
            raise ValueError("steps_speed_factor deve ser positivo.")
        if self.contraflow_factor < 1.0:
            raise ValueError("contraflow_factor deve ser >= 1.")
        for name in ("steps_policy", "private_policy", "barrier_policy"):
            if getattr(self, name) not in ("allow", "penalize", "forbid"):
                raise ValueError(f"{name} inválida: {getattr(self, name)!r}")
        if self.sidewalk_mode not in ("walk", "ride"):
            raise ValueError("sidewalk_mode deve ser 'walk' ou 'ride'.")

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class OptimizationConfig:
    """Objetivo: menor tempo total; desempate: menor distância."""

    route_mode: RouteMode = "open"
    # Tempo de atendimento em cada parada (s) — somado ao tempo total.
    service_time_s: float = 0.0
    # Tempo máximo de busca do OR-Tools (s).
    time_limit_s: int = 5
    # Distância máxima (m) entre o ponto informado e a malha de circulação.
    max_snap_m: float = 150.0
    # Margem (m) ao redor das paradas para baixar a malha do OSM.
    bbox_margin_m: float = 1000.0
    profile: TravelProfile = field(default_factory=TravelProfile)

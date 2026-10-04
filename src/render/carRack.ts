/**
 * Every car model of the line-up under one parent, each built on first use and kept; exactly one is visible.
 * The garage podium and the race scene each own a rack. Every body uses the same four material types, so a car
 * shown for the first time reuses the compiled shader programs (no compile hitch, only a small geometry upload).
 */
import type * as THREE from 'three';
import { DEFAULT_CAR, type CarId } from '../shared/cars';
import { CAR_BODIES } from './carBodies';
import { createCarModel, type CarModel } from './carModel';

export interface CarRack {
  /** The visible car's model. */
  readonly current: CarModel;
  readonly currentId: CarId;
  /** Make `id` the visible car (built on first use, `prepare` applied once) and return its model. */
  show(id: CarId): CarModel;
}

export function createCarRack(parent: THREE.Object3D, prepare: (car: CarModel) => void, initial: CarId = DEFAULT_CAR): CarRack {
  const models = new Map<CarId, CarModel>();

  function modelFor(id: CarId): CarModel {
    let model = models.get(id);
    if (!model) {
      model = createCarModel(CAR_BODIES[id]);
      prepare(model);
      model.root.visible = false;
      parent.add(model.root);
      models.set(id, model);
    }
    return model;
  }

  let currentId = initial;
  let current = modelFor(initial);
  current.root.visible = true;

  return {
    get current() {
      return current;
    },
    get currentId() {
      return currentId;
    },
    show(id) {
      if (id === currentId) return current;
      const next = modelFor(id);
      current.root.visible = false;
      next.root.visible = true;
      current = next;
      currentId = id;
      return next;
    },
  };
}

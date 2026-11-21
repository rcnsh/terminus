function storage(name) {
  const area = () => globalThis[name];
  const get = (key) => {
    try {
      return area().getItem(key);
    } catch {
      return null;
    }
  };
  const set = (key, value) => {
    try {
      area().setItem(key, value);
      return true;
    } catch {
      return false;
    }
  };
  const remove = (key) => {
    try {
      area().removeItem(key);
      return true;
    } catch {
      return false;
    }
  };
  const json = (key) => {
    try {
      return JSON.parse(get(key) ?? 'null');
    } catch {
      return null;
    }
  };
  return { get, set, remove, json };
}

export const local = storage('localStorage');
export const perTab = storage('sessionStorage');

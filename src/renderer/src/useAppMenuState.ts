import { useEffect, useState } from "react";

export function useAppMenuState() {
  const [openAppMenu, setOpenAppMenu] = useState("");

  useEffect(() => {
    if (!openAppMenu) return;
    const close = () => setOpenAppMenu("");
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };

    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [openAppMenu]);

  return { openAppMenu, setOpenAppMenu };
}

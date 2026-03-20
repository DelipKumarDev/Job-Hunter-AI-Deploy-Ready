// ============================================================
// Job Hunter AI — React Native App Root
// ============================================================
import React from 'react';
import { StatusBar } from 'expo-status-bar';
import Navigation from './navigation/index';

export default function App() {
  return (
    <>
      <StatusBar style="auto" />
      <Navigation />
    </>
  );
}
